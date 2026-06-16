-- Incremento Admin — email OTP login codes
-- Run: wrangler d1 execute incremento-admin --file worker/schema-otp.sql --remote

CREATE TABLE IF NOT EXISTS otp_codes (
  email      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL   -- unix seconds
);
