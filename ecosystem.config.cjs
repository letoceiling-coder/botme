// PM2 process config — botme.neeklo.ru
// Запуск:  pm2 start ecosystem.config.cjs
// Сохранить автозапуск: pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'botme',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',         // Express + better-sqlite3 — single instance
      instances: 1,
      max_memory_restart: '512M',
      autorestart: true,
      watch: false,              // в проде не следим за файлами — деплой делает git pull + pm2 reload
      time: true,
      env: {
        NODE_ENV: 'production',
        // PORT берётся из .env, который dotenv грузит в server.js
      },
      // Логи в каталоге проекта (pm2 logs botme)
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
