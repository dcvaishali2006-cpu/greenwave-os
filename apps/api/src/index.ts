import { createApp } from './app.js';
import { config } from './config.js';

const ctx = createApp();
const port = await ctx.start();
console.log(`GreenWave API on http://localhost:${port}  (scenario ${config.simScenario}, seed ${config.simSeed}, speed x${config.simSpeed})`);
console.log('Demo accounts: admin@demo.com, operator@demo.com, viewer@demo.com  password: demo1234');

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ctx.close().then(() => process.exit(0)));
