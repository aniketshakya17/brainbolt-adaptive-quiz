-- =========================
-- INSERT TEST USER
-- =========================
INSERT INTO users (id)
VALUES ('11111111-1111-1111-1111-111111111111')
ON CONFLICT DO NOTHING;

INSERT INTO user_state (user_id)
VALUES ('11111111-1111-1111-1111-111111111111')
ON CONFLICT DO NOTHING;

-- Questions are seeded via npm run seed (src/seed.ts) to avoid mock data here.
