# 09 — Security Checklist

Before production:

- [ ] HTTPS enabled
- [ ] Strong APP_SECRET
- [ ] No secrets in Git
- [ ] `.env` permissions restricted to the deployment user/root
- [ ] PostgreSQL is not publicly exposed
- [ ] PostgreSQL password is strong and unique
- [ ] Database backups configured
- [ ] Backup restore tested
- [ ] OAuth tokens encrypted in application storage
- [ ] Encryption key stored outside PostgreSQL
- [ ] CSRF protection where applicable
- [ ] Rate limiting on generation and publish endpoints
- [ ] Webhook signatures verified
- [ ] n8n protected and not unnecessarily public
- [ ] Admin authentication enabled
- [ ] Audit logs enabled
- [ ] Error messages do not leak tokens or database credentials
- [ ] File upload validation enabled
- [ ] Maximum video size configured
- [ ] Temporary files cleaned
