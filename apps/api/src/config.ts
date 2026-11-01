const DEV_SECRET = 'dev-only-secret-change-me';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  jwtSecret: process.env.JWT_SECRET ?? DEV_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? `${DEV_SECRET}-refresh`,
  accessTtl: '15m',
  refreshTtl: '7d',
  simSpeed: Number(process.env.SIM_SPEED ?? 1),
  simScenario: process.env.SIM_SCENARIO ?? 'normal',
  simSeed: Number(process.env.SIM_SEED ?? 7),
};

if (process.env.NODE_ENV === 'production' && config.jwtSecret === DEV_SECRET) {
  throw new Error('Set JWT_SECRET and JWT_REFRESH_SECRET before running in production.');
}
