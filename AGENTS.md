# Marketplace

Use Bun in both frontend and backend. Run `bun run typecheck` in each package and `bun run build` in frontend.

Backend uses Express, Better Auth and parameterized MySQL through `mysql2`. Use `.js` suffixes for local backend imports. Preserve buyer, seller, and admin access rules and the response shapes consumed by the React Router frontend.

Deploy frontend and API on Linode behind a single HTTPS origin. Use `backend/.env.example` as the configuration template and run `bun run db:migrate` before starting the API.
