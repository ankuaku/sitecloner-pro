// PM2 config: pm2 start ecosystem.config.cjs
module.exports = { apps: [{ name: 'sitecloner-pro', script: 'server.js', env: { NODE_ENV: 'production' } }] };
