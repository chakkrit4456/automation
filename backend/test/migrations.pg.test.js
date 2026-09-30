// Runs only against a real PostgreSQL:  TEST_DATABASE_URL=postgresql://... npm test
// Each run works in its own throwaway schema and drops it afterwards.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
const { Pool } = require("pg");
const { runMigrations } = require("../src/store-pg");

const url = process.env.TEST_DATABASE_URL;
const schemaSql = fs.readFileSync(path.resolve(__dirname, "..", "..", "database", "schema.sql"), "utf8");

test("001_multi_accounts keeps legacy rows and links them to the default account", { skip: !url && "TEST_DATABASE_URL not set" }, async () => {
  const schema = `mig_${randomBytes(4).toString("hex")}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema},public` });
  try {
    await pool.query(schemaSql);
    // Data shaped like the one-account-per-platform version.
    const acc = (await pool.query(
      "INSERT INTO social_accounts (platform, account_name, status) VALUES ('youtube','Old channel','CONNECTED') RETURNING id"
    )).rows[0].id;
    const content = (await pool.query("INSERT INTO content (topic, hook) VALUES ('legacy','h') RETURNING id")).rows[0].id;
    const sched = (await pool.query(
      "INSERT INTO scheduled_posts (content_id, platform, scheduled_at) VALUES ($1,'youtube',now()) RETURNING id",
      [content]
    )).rows[0].id;
    await pool.query(
      "INSERT INTO social_posts (scheduled_post_id, platform, status, external_post_id) VALUES ($1,'youtube','SUCCESS','yt-1')",
      [sched]
    );

    assert.deepEqual(await runMigrations(pool), ["001_multi_accounts"]);
    assert.deepEqual(await runMigrations(pool), []);

    const account = (await pool.query("SELECT * FROM social_accounts WHERE id = $1", [acc])).rows[0];
    assert.equal(account.is_default, true);
    assert.equal(account.account_name, "Old channel");
    const row = (await pool.query("SELECT * FROM scheduled_posts WHERE id = $1", [sched])).rows[0];
    assert.equal(row.account_id, acc);
    const post = (await pool.query("SELECT * FROM social_posts WHERE scheduled_post_id = $1", [sched])).rows[0];
    assert.equal(post.external_post_id, "yt-1");
    assert.deepEqual((await pool.query("SELECT account_ids FROM content WHERE id = $1", [content])).rows[0].account_ids, []);

    // A second account on the same platform can now be queued for the same content.
    const second = (await pool.query(
      "INSERT INTO social_accounts (platform, account_name) VALUES ('youtube','New channel') RETURNING id, is_default"
    )).rows[0];
    assert.equal(second.is_default, false);
    await pool.query(
      "INSERT INTO scheduled_posts (content_id, platform, account_id, scheduled_at) VALUES ($1,'youtube',$2,now())",
      [content, second.id]
    );
    await assert.rejects(
      pool.query("INSERT INTO scheduled_posts (content_id, platform, account_id, scheduled_at) VALUES ($1,'youtube',$2,now())", [content, second.id]),
      /duplicate key/
    );
    await assert.rejects(pool.query("UPDATE social_accounts SET is_default = true WHERE id = $1", [second.id]), /duplicate key/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
