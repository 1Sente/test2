const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Сессии
app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, 
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true
    }
}));

// Конфигурация
const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'database.db');
const SALT_ROUNDS = 12;

// Создание необходимых директорий
async function createDirectories() {
    try {
        await fs.mkdir(DB_DIR, { recursive: true });
        await fs.mkdir(path.join(__dirname, 'config'), { recursive: true });
        await fs.mkdir(path.join(__dirname, 'logs'), { recursive: true });
        console.log('✅ Директории созданы');
    } catch (error) {
        console.error('❌ Ошибка создания директорий:', error);
        throw error;
    }
}

// Инициализация базы данных
async function initializeDatabase() {
    await createDirectories();
    
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_FILE, (err) => {
            if (err) {
                console.error('❌ Ошибка подключения к БД:', err);
                reject(err);
            } else {
                console.log('✅ Подключение к SQLite установлено');
            }
        });

        // Создаем таблицы
        db.serialize(() => {
            // Таблица пользователей
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, (err) => {
                if (err) console.error('Ошибка создания таблицы users:', err);
            });

            // Таблица форм
            db.run(`CREATE TABLE IF NOT EXISTS forms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                form_id TEXT UNIQUE NOT NULL,
                form_name TEXT NOT NULL,
                webhook_url TEXT NOT NULL,
                title TEXT DEFAULT '',
                description TEXT DEFAULT '',
                color TEXT DEFAULT '#5865f2',
                footer TEXT DEFAULT 'Яндекс Формы',
                mentions TEXT DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, (err) => {
                if (err) console.error('Ошибка создания таблицы forms:', err);
            });

            // Таблица логов
            db.run(`CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                form_id TEXT,
                status TEXT NOT NULL,
                message TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, (err) => {
                if (err) console.error('Ошибка создания таблицы logs:', err);
            });

            // Создаем администратора по умолчанию
            const defaultPassword = 'admin123'; // СМЕНИТЕ ЭТОТ ПАРОЛЬ!
            bcrypt.hash(defaultPassword, SALT_ROUNDS, (err, hash) => {
                if (err) {
                    console.error('Ошибка хеширования пароля:', err);
                    return;
                }
                
                db.run(`INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)`, 
                    ['admin', hash], 
                    function(err) {
                        if (err) {
                            console.error('Ошибка создания администратора:', err);
                        } else {
                            if (this.changes > 0) {
                                console.log('👑 Создан администратор по умолчанию: admin / admin123');
                                console.log('🔐 СМЕНИТЕ ПАРОЛЬ В КОДЕ!');
                            } else {
                                console.log('👑 Администратор уже существует');
                            }
                        }
                    }
                );
            });
        });

        resolve(db);
    });
}

// Middleware проверки аутентификации
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        next();
    } else {
        res.status(401).json({ status: 'error', message: 'Требуется аутентификация' });
    }
}

// Функция логирования
async function logRequest(formId, status, message = '') {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO logs (form_id, status, message) VALUES (?, ?, ?)`,
            [formId, status, message],
            function(err) {
                if (err) {
                    console.error('Ошибка записи лога:', err);
                    reject(err);
                } else {
                    resolve();
                }
            }
        );
    });
}

// Валидация webhook URL
function isValidWebhookUrl(url) {
    return url && url.startsWith('https://discord.com/api/webhooks/');
}

// Функция отправки сообщения в Discord
async function sendDiscordMessage(formConfig, formData, questions, answers) {
    // Находим Discord ID в первом ответе
    let discordId = null;
    if (answers && answers.length > 0) {
        const firstAnswer = answers[0];
        discordId = firstAnswer.text ? firstAnswer.text.trim() : null;
        
        // Очищаем Discord ID от лишних символов (оставляем только цифры)
        if (discordId) {
            discordId = discordId.replace(/[^0-9]/g, '');
        }
    }

    // Формируем упоминание для content (только роль из настроек)
    let mentionContent = '';
    if (formConfig.mentions) {
        const additionalMentions = formConfig.mentions.split(',')
            .map(id => id.trim())
            .filter(id => id.length >= 17)
            .map(id => `<@&${id}>`) // Упоминание роли
            .join(' ');
        
        if (additionalMentions) {
            mentionContent = additionalMentions;
        }
    }

    // Создаем Embed сообщение
    const embed = {
        title: formConfig.title || `📋 ${formData.title || formConfig.form_name}`,
        description: formConfig.description || null,
        color: parseInt((formConfig.color || '#5865f2').replace('#', ''), 16),
        fields: [],
        timestamp: new Date().toISOString(),
        footer: formConfig.footer ? { text: formConfig.footer } : undefined
    };

    // Добавляем поля с вопросами и ответами
    answers.forEach((answer, index) => {
        const question = questions[index] || { text: `Вопрос ${index + 1}` };
        if (question && answer.text) {
            const isDiscordIdField = index === 0;
            
            // Для первого поля (Discord ID) добавляем упоминание пользователя в embed
            if (isDiscordIdField && discordId && discordId.length >= 17) {
                embed.fields.push({
                    name: question.text,
                    value: `<@${discordId}>`, // Упоминание пользователя в embed
                    inline: false
                });
            } else {
                const fieldValue = answer.text.length > 1024 ? 
                    answer.text.substring(0, 1020) + '...' : answer.text;
                
                embed.fields.push({
                    name: question.text,
                    value: fieldValue,
                    inline: false
                });
            }
        }
    });

    // Если нет полей, добавляем информационное сообщение
    if (embed.fields.length === 0) {
        embed.fields.push({
            name: '📝 Информация',
            value: 'Нет данных для отображения',
            inline: false
        });
    }

    // Отправляем в Discord
    const payload = {
        embeds: [embed]
    };

    // Добавляем контент с упоминаниями ролей если есть
    if (mentionContent) {
        payload.content = mentionContent;
    }

    const response = await axios.post(formConfig.webhook_url, payload);
    return response.data;
}

let db;

// HTML страница входа (без изменений)
const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Вход в панель управления</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root {
            --primary: #5865f2;
            --primary-dark: #4752c4;
            --success: #57f287;
            --danger: #ed4245;
            --dark: #2f3136;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Whitney', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: var(--dark);
            color: #dcddde; 
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }
        
        .login-container {
            background: #36393f;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            width: 400px;
            max-width: 90%;
        }
        
        .header { 
            text-align: center;
            margin-bottom: 2rem;
        }
        
        .header h1 { 
            font-size: 1.5rem; 
            margin-bottom: 0.5rem; 
            color: white;
        }
        
        .form-group { 
            margin-bottom: 1.5rem; 
        }
        
        label { 
            display: block; 
            margin-bottom: 0.5rem; 
            font-weight: 600; 
            color: #b9bbbe;
            font-size: 0.9rem;
        }
        
        input { 
            width: 100%; 
            padding: 12px;
            background: #40444b;
            border: 1px solid #40444b;
            border-radius: 4px; 
            font-size: 14px; 
            color: #dcddde;
            transition: all 0.2s;
        }
        
        input:focus { 
            outline: none; 
            border-color: var(--primary);
        }
        
        .btn { 
            background: var(--primary);
            color: white; 
            border: none; 
            padding: 12px 24px; 
            border-radius: 4px; 
            cursor: pointer; 
            font-size: 14px; 
            font-weight: 600;
            transition: all 0.2s;
            width: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 8px;
        }
        
        .btn:hover { 
            background: var(--primary-dark);
        }
        
        .alert { 
            padding: 1rem; 
            border-radius: 4px; 
            margin-bottom: 1.5rem; 
            display: none;
        }
        
        .alert-error { 
            background: var(--danger); 
            color: white; 
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="header">
            <h1><i class="fab fa-discord"></i> Панель управления</h1>
            <p>Введите логин и пароль для доступа</p>
        </div>

        <div id="alert" class="alert alert-error">
            Неверный логин или пароль
        </div>

        <form id="loginForm">
            <div class="form-group">
                <label for="username"><i class="fas fa-user"></i> Логин</label>
                <input type="text" id="username" name="username" required autocomplete="username">
            </div>

            <div class="form-group">
                <label for="password"><i class="fas fa-lock"></i> Пароль</label>
                <input type="password" id="password" name="password" required autocomplete="current-password">
            </div>

            <button type="submit" class="btn">
                <i class="fas fa-sign-in-alt"></i> Войти
            </button>
        </form>
    </div>

    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData);
            
            try {
                const response = await fetch('/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                    credentials: 'include'
                });
                
                const result = await response.json();
                
                if (result.status === 'success') {
                    window.location.href = '/admin';
                } else {
                    document.getElementById('alert').style.display = 'block';
                    document.getElementById('alert').textContent = result.message;
                }
            } catch (error) {
                document.getElementById('alert').style.display = 'block';
                document.getElementById('alert').textContent = 'Ошибка соединения';
            }
        });
    </script>
</body>
</html>
`;

// HTML админки (обновляем текст подсказок)
const ADMIN_HTML = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Управление Яндекс Формами → Discord</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root {
            --primary: #5865f2;
            --primary-dark: #4752c4;
            --success: #57f287;
            --danger: #ed4245;
            --warning: #fee75c;
            --info: #5865f2;
            --dark: #2f3136;
            --light: #f8fafc;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Whitney', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: var(--dark);
            color: #dcddde; 
            line-height: 1.6;
            min-height: 100vh;
        }
        
        .container { 
            max-width: 1400px; 
            margin: 0 auto; 
            padding: 20px; 
        }
        
        .header-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid #40444b;
        }
        
        .user-info {
            display: flex;
            align-items: center;
            gap: 1rem;
        }
        
        .logout-btn {
            background: var(--danger);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .logout-btn:hover {
            background: #c03537;
        }
        
        .discord-card {
            background: #36393f;
            border-radius: 8px;
            padding: 2rem;
            margin-bottom: 1.5rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            border: 1px solid #40444b;
        }
        
        .header { 
            text-align: center;
            margin-bottom: 2rem;
        }
        
        .header h1 { 
            font-size: 2.5rem; 
            margin-bottom: 0.5rem; 
            color: white;
            font-weight: 700;
        }
        
        .header p { 
            font-size: 1.1rem;
            color: #b9bbbe;
        }
        
        .stats-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
            gap: 1.5rem; 
            margin-bottom: 2rem; 
        }
        
        .stat-card { 
            background: #40444b;
            color: white;
            padding: 1.5rem;
            border-radius: 8px;
            text-align: center;
            border-left: 4px solid var(--primary);
        }
        
        .stat-number { 
            font-size: 2rem; 
            font-weight: bold; 
            margin-bottom: 0.5rem;
            color: var(--success);
        }
        
        .form-grid { 
            display: grid; 
            grid-template-columns: 1fr 1fr; 
            gap: 1.5rem; 
        }
        
        @media (max-width: 768px) {
            .form-grid {
                grid-template-columns: 1fr;
            }
        }
        
        .form-group { 
            margin-bottom: 1.5rem; 
        }
        
        label { 
            display: block; 
            margin-bottom: 0.5rem; 
            font-weight: 600; 
            color: #b9bbbe;
            font-size: 0.9rem;
        }
        
        input, select, textarea { 
            width: 100%; 
            padding: 12px;
            background: #40444b;
            border: 1px solid #40444b;
            border-radius: 4px; 
            font-size: 14px; 
            color: #dcddde;
            transition: all 0.2s;
        }
        
        input:focus, select:focus, textarea:focus { 
            outline: none; 
            border-color: var(--primary);
            background: #40444b;
        }
        
        .btn { 
            background: var(--primary);
            color: white; 
            border: none; 
            padding: 12px 24px; 
            border-radius: 4px; 
            cursor: pointer; 
            font-size: 14px; 
            font-weight: 600;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn:hover { 
            background: var(--primary-dark);
        }
        
        .btn-block {
            width: 100%;
            justify-content: center;
        }
        
        .btn-success { background: var(--success); color: #000; }
        .btn-success:hover { background: #45d87c; }
        .btn-danger { background: var(--danger); }
        .btn-danger:hover { background: #c03537; }
        .btn-warning { background: var(--warning); color: #000; }
        .btn-warning:hover { background: #e6d252; }
        .btn-secondary { background: #4f545c; }
        .btn-secondary:hover { background: #5d6269; }
        
        .forms-container {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 1.5rem;
        }
        
        .form-card { 
            background: #40444b;
            border-radius: 8px;
            padding: 1.5rem;
            border: 1px solid #40444b;
            transition: all 0.2s;
            position: relative;
        }
        
        .form-card:hover {
            border-color: var(--primary);
        }
        
        .form-card h3 { 
            margin-bottom: 1rem; 
            color: white;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .form-card p { 
            margin-bottom: 0.5rem; 
            color: #b9bbbe; 
            font-size: 0.9rem;
        }
        
        .form-actions { 
            display: flex; 
            gap: 0.5rem; 
            margin-top: 1.5rem;
            flex-wrap: wrap;
        }
        
        .form-actions .btn {
            flex: 1;
            min-width: 100px;
            padding: 8px 12px;
            font-size: 12px;
        }
        
        .alert { 
            padding: 1rem 1.5rem; 
            border-radius: 4px; 
            margin-bottom: 1.5rem; 
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .alert-success { 
            background: var(--success); 
            color: #000; 
        }
        
        .alert-error { 
            background: var(--danger); 
            color: white; 
        }
        
        .alert-warning { 
            background: var(--warning); 
            color: #000; 
        }
        
        .hidden { display: none; }
        
        .tab-container {
            margin-bottom: 2rem;
        }
        
        .tabs {
            display: flex;
            background: #40444b;
            border-radius: 4px;
            padding: 4px;
            margin-bottom: 1.5rem;
        }
        
        .tab {
            flex: 1;
            padding: 12px 20px;
            text-align: center;
            cursor: pointer;
            border-radius: 4px;
            transition: all 0.2s;
            font-weight: 600;
            color: #b9bbbe;
        }
        
        .tab.active {
            background: var(--primary);
            color: white;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            margin-left: 8px;
        }
        
        .badge-success { background: var(--success); color: #000; }
        .badge-warning { background: var(--warning); color: #000; }
        .badge-danger { background: var(--danger); color: white; }
        
        .webhook-url {
            background: #40444b;
            border: 1px solid #40444b;
            border-radius: 4px;
            padding: 1rem;
            margin: 1rem 0;
            font-family: 'Consolas', monospace;
            word-break: break-all;
            font-size: 0.9rem;
        }
        
        .copy-btn {
            background: var(--primary);
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            margin-left: 10px;
            font-size: 12px;
        }

        .config-section {
            background: #40444b;
            border-radius: 4px;
            padding: 1.5rem;
            margin: 1rem 0;
        }

        .config-section h3 {
            margin-bottom: 1rem;
            color: white;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .color-preview {
            width: 20px;
            height: 20px;
            border-radius: 4px;
            display: inline-block;
            margin-right: 8px;
            vertical-align: middle;
            border: 1px solid #666;
        }

        .mention-example {
            background: #2f3136;
            padding: 8px 12px;
            border-radius: 4px;
            margin: 8px 0;
            font-family: 'Consolas', monospace;
            font-size: 0.8rem;
            border-left: 3px solid var(--primary);
        }

        .embed-preview {
            background: #2f3136;
            border-radius: 8px;
            padding: 1rem;
            margin: 1rem 0;
            border-left: 4px solid #5865f2;
            max-width: 500px;
        }

        .embed-preview .author {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            font-weight: 600;
        }

        .embed-preview .title {
            font-weight: 600;
            margin-bottom: 8px;
            color: white;
        }

        .embed-preview .field {
            margin: 8px 0;
            padding: 8px;
            background: #40444b;
            border-radius: 4px;
        }

        .embed-preview .field .name {
            font-weight: 600;
            color: var(--success);
            margin-bottom: 4px;
        }

        .embed-preview .footer {
            margin-top: 8px;
            font-size: 0.8rem;
            color: #72767d;
        }

        .info-box {
            background: #2f3136;
            border: 1px solid var(--primary);
            border-radius: 4px;
            padding: 1rem;
            margin: 1rem 0;
        }

        .info-box h4 {
            color: var(--success);
            margin-bottom: 0.5rem;
            display: flex;
            align-items: center;
            gap: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-bar">
            <div class="header">
                <h1><i class="fab fa-discord"></i> Яндекс Формы → Discord</h1>
                <p>Автоматические упоминания: пользователь в сообщении, роль сверху</p>
            </div>
            <div class="user-info">
                <span>Вы вошли как: <strong id="username">admin</strong></span>
                <button class="logout-btn" onclick="logout()">
                    <i class="fas fa-sign-out-alt"></i> Выйти
                </button>
            </div>
        </div>

        <div id="alert" class="alert hidden"></div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-number" id="totalForms">0</div>
                <div>Активных форм</div>
            </div>
            <div class="stat-card">
                <div class="stat-number"><i class="fas fa-check-circle"></i></div>
                <div>Статус сервера</div>
            </div>
            <div class="stat-card">
                <div class="stat-number"><i class="fas fa-at"></i></div>
                <div>Умные упоминания</div>
            </div>
        </div>

        <div class="info-box">
            <h4><i class="fas fa-info-circle"></i> Новая логика упоминаний</h4>
            <p><strong>Первый вопрос в форме должен быть "Discord ID"!</strong></p>
            <p><strong>В сообщении:</strong> пользователь будет упомянут по Discord ID из первого поля</p>
            <p><strong>Сверху:</strong> будет упомянута роль из настроек (если указана)</p>
        </div>

        <div class="tab-container">
            <div class="tabs">
                <div class="tab active" onclick="showTab('manage')"><i class="fas fa-cog"></i> Управление формами</div>
                <div class="tab" onclick="showTab('webhook')"><i class="fas fa-link"></i> Webhook URL</div>
                <div class="tab" onclick="showTab('logs')"><i class="fas fa-history"></i> История запросов</div>
            </div>

            <!-- Вкладка управления формами -->
            <div id="manage" class="tab-content active">
                <div class="form-grid">
                    <div class="discord-card">
                        <h2><i class="fas fa-plus-circle"></i> Добавить новую связь</h2>
                        <form id="registerForm">
                            <div class="form-group">
                                <label for="formId"><i class="fas fa-fingerprint"></i> ID Яндекс Формы *</label>
                                <input type="text" id="formId" name="formId" required 
                                       placeholder="1234567890abcdef">
                            </div>

                            <div class="form-group">
                                <label for="formName"><i class="fas fa-heading"></i> Название формы *</label>
                                <input type="text" id="formName" name="formName" required 
                                       placeholder="Форма обратной связи">
                            </div>

                            <div class="form-group">
                                <label for="discordWebhookUrl"><i class="fab fa-discord"></i> Discord Webhook URL *</label>
                                <input type="url" id="discordWebhookUrl" name="discordWebhookUrl" required 
                                       placeholder="https://discord.com/api/webhooks/...">
                            </div>

                            <button type="submit" class="btn btn-block">
                                <i class="fas fa-save"></i> Зарегистрировать связь
                            </button>
                        </form>
                    </div>

                    <div class="discord-card">
                        <h2><i class="fas fa-list"></i> Быстрые действия</h2>
                        
                        <div class="form-group">
                            <label>Тестирование вебхука</label>
                            <select id="testFormId">
                                <option value="">-- Выберите форму --</option>
                            </select>
                            <button onclick="testWebhook()" class="btn btn-secondary btn-block" style="margin-top: 10px;">
                                <i class="fas fa-vial"></i> Тестовое сообщение
                            </button>
                        </div>

                        <div class="form-group">
                            <label>Система</label>
                            <button onclick="clearLogs()" class="btn btn-danger btn-block">
                                <i class="fas fa-trash"></i> Очистить логи
                            </button>
                        </div>
                    </div>
                </div>

                <div class="discord-card">
                    <h2><i class="fas fa-th-list"></i> Зарегистрированные формы <span class="badge badge-success" id="formsCount">0</span></h2>
                    <div id="formsList" class="forms-container">
                        <div class="form-card">
                            <p>Загрузка...</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Вкладка Webhook URL -->
            <div id="webhook" class="tab-content">
                <div class="discord-card">
                    <h2><i class="fas fa-link"></i> Webhook URL для Яндекс Форм</h2>
                    <p>Используйте этот URL в настройках вебхука всех ваших Яндекс Форм:</p>
                    
                    <div class="webhook-url">
                        <span id="webhookUrlText">Загрузка...</span>
                        <button class="copy-btn" onclick="copyWebhookUrl()">
                            <i class="fas fa-copy"></i> Копировать
                        </button>
                    </div>
                </div>
            </div>

            <!-- Вкладка логов -->
            <div id="logs" class="tab-content">
                <div class="discord-card">
                    <h2><i class="fas fa-history"></i> История запросов</h2>
                    <div id="logsContent" style="max-height: 500px; overflow-y: auto; background: #2f3136; padding: 1rem; border-radius: 4px; font-family: monospace; font-size: 12px;">
                        Загрузка логов...
                    </div>
                    <button onclick="loadLogs()" class="btn btn-secondary" style="margin-top: 15px;">
                        <i class="fas fa-sync"></i> Обновить логи
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- Модальное окно настройки формы -->
    <div id="configModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; justify-content: center; align-items: center;">
        <div class="discord-card" style="max-width: 600px; width: 95%; max-height: 90vh; overflow-y: auto;">
            <h2><i class="fas fa-sliders-h"></i> Настройка внешнего вида</h2>
            <p>Настройте как будут выглядеть сообщения из этой формы в Discord</p>
            
            <div class="info-box">
                <h4><i class="fas fa-at"></i> Новая логика упоминаний</h4>
                <p><strong>В сообщении:</strong> пользователь будет упомянут по Discord ID из первого поля</p>
                <p><strong>Сверху:</strong> будет упомянута роль указанная ниже</p>
            </div>
            
            <div class="config-section">
                <h3><i class="fas fa-palette"></i> Внешний вид сообщения</h3>
                
                <div class="form-group">
                    <label for="configTitle">Заголовок сообщения</label>
                    <input type="text" id="configTitle" placeholder="Оставьте пустым для названия формы">
                </div>

                <div class="form-group">
                    <label for="configDescription">Описание</label>
                    <textarea id="configDescription" rows="2" placeholder="Текст, который будет отображаться под заголовком"></textarea>
                </div>

                <div class="form-group">
                    <label for="configColor">Цвет сообщения</label>
                    <input type="color" id="configColor" value="#5865f2" style="width: 60px; height: 40px; margin-left: 10px;">
                    <span id="configColorText">#5865f2</span>
                </div>

                <div class="form-group">
                    <label for="configFooter">Текст в подвале</label>
                    <input type="text" id="configFooter" placeholder="Например: Яндекс Формы">
                </div>
            </div>

            <div class="config-section">
                <h3><i class="fas fa-at"></i> Упоминание роли (сверху)</h3>
                <p style="margin-bottom: 1rem; font-size: 0.9rem; color: #b9bbbe;">
                    Укажите ID роли для упоминания в верхней части сообщения
                </p>
                
                <div class="form-group">
                    <label for="configMentions">ID роли для упоминания</label>
                    <input type="text" id="configMentions" placeholder="123456789012345678">
                    <div class="mention-example">
                        Пример: 123456789012345678<br>
                        Роль будет упомянута сверху: &lt;@&123456789012345678&gt;
                    </div>
                </div>
            </div>

            <div class="config-section">
                <h3><i class="fas fa-eye"></i> Предпросмотр</h3>
                <div class="embed-preview">
                    <div class="author">
                        <i class="fas fa-user"></i>
                        <span>Имя вебхука</span>
                    </div>
                    <div class="title" id="previewTitle">Заголовок сообщения</div>
                    <div class="field">
                        <div class="name">Discord ID</div>
                        <div>&lt;@123456789012345678&gt; 👆 Упоминание в сообщении</div>
                    </div>
                    <div class="field">
                        <div class="name">Вопрос 2</div>
                        <div>Ответ 2</div>
                    </div>
                    <div class="footer" id="previewFooter">Текст подвала</div>
                </div>
            </div>

            <div style="display: flex; gap: 10px; margin-top: 1.5rem;">
                <button onclick="saveFormConfig()" class="btn btn-success">
                    <i class="fas fa-check"></i> Сохранить настройки
                </button>
                <button onclick="hideConfigModal()" class="btn btn-danger">
                    <i class="fas fa-times"></i> Отмена
                </button>
                <button onclick="resetFormConfig()" class="btn btn-secondary">
                    <i class="fas fa-undo"></i> Сбросить
                </button>
            </div>
        </div>
    </div>

    <script>
        let currentEditingForm = null;

        // Загрузка списка форм
        async function loadForms() {
            try {
                const response = await fetch('/admin/forms', {
                    credentials: 'include'
                });
                
                if (response.status === 401) {
                    window.location.href = '/admin/login';
                    return;
                }
                
                const data = await response.json();
                
                document.getElementById('totalForms').textContent = data.total;
                document.getElementById('formsCount').textContent = data.total;
                
                const formsGrid = document.getElementById('formsList');
                const testSelect = document.getElementById('testFormId');
                
                if (data.forms.length === 0) {
                    formsGrid.innerHTML = '<div class="form-card"><p><i class="fas fa-inbox"></i> Нет зарегистрированных форм</p></div>';
                    testSelect.innerHTML = '<option value="">-- Нет форм --</option>';
                    return;
                }
                
                formsGrid.innerHTML = '';
                testSelect.innerHTML = '<option value="">-- Выберите форму --</option>';
                
                data.forms.forEach(form => {
                    // Карточка формы
                    const formCard = document.createElement('div');
                    formCard.className = 'form-card';
                    formCard.innerHTML = \`
                        <h3><i class="fas fa-form"></i> \${form.formName}</h3>
                        <p><strong>ID:</strong> \${form.formId}</p>
                        <p><strong>Webhook:</strong> \${form.webhookPreview}</p>
                        <p><strong>Роль для упоминания:</strong> \${form.mentions || 'Не указана'}</p>
                        <div class="form-actions">
                            <button onclick="configureForm('\${form.formId}')" class="btn btn-secondary">
                                <i class="fas fa-cog"></i> Настроить
                            </button>
                            <button onclick="deleteForm('\${form.formId}')" class="btn btn-danger">
                                <i class="fas fa-trash"></i> Удалить
                            </button>
                            <button onclick="testSpecificForm('\${form.formId}')" class="btn">
                                <i class="fas fa-vial"></i> Тест
                            </button>
                        </div>
                    \`;
                    formsGrid.appendChild(formCard);
                    
                    // Опция для тестового селекта
                    const option = document.createElement('option');
                    option.value = form.formId;
                    option.textContent = \`\${form.formName} (\${form.formId})\`;
                    testSelect.appendChild(option);
                });
            } catch (error) {
                console.error('Ошибка загрузки форм:', error);
                showAlert('Ошибка загрузки форм', 'error');
            }
        }
        
        // Регистрация новой формы
        document.getElementById('registerForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData);
            
            try {
                const response = await fetch('/admin/register-form', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                    credentials: 'include'
                });
                
                if (response.status === 401) {
                    window.location.href = '/admin/login';
                    return;
                }
                
                const result = await response.json();
                
                if (result.status === 'success') {
                    showAlert(result.message, 'success');
                    e.target.reset();
                    loadForms();
                } else {
                    showAlert(result.message, 'error');
                }
            } catch (error) {
                showAlert('Ошибка при регистрации формы', 'error');
            }
        });
        
        // Удаление формы
        async function deleteForm(formId) {
            if (!confirm('Вы уверены, что хотите удалить эту связь?')) return;
            
            try {
                const response = await fetch(\`/admin/forms/\${formId}\`, { 
                    method: 'DELETE',
                    credentials: 'include'
                });
                
                if (response.status === 401) {
                    window.location.href = '/admin/login';
                    return;
                }
                
                const result = await response.json();
                
                if (result.status === 'success') {
                    showAlert(result.message, 'success');
                    loadForms();
                } else {
                    showAlert(result.message, 'error');
                }
            } catch (error) {
                showAlert('Ошибка при удалении формы', 'error');
            }
        }
        
        // Настройка формы
        async function configureForm(formId) {
            currentEditingForm = formId;
            
            try {
                const response = await fetch(\`/admin/forms/\${formId}/config\`, {
                    credentials: 'include'
                });
                
                if (response.status === 401) {
                    window.location.href = '/admin/login';
                    return;
                }
                
                const config = await response.json();
                
                // Заполняем поля формы
                document.getElementById('configTitle').value = config.title || '';
                document.getElementById('configDescription').value = config.description || '';
                document.getElementById('configColor').value = config.color || '#5865f2';
                document.getElementById('configColorText').textContent = config.color || '#5865f2';
                document.getElementById('configFooter').value = config.footer || '';
                document.getElementById('configMentions').value = config.mentions || '';
                
                // Обновляем предпросмотр
                updatePreview();
                
                // Показываем модальное окно
                document.getElementById('configModal').style.display = 'flex';
                
            } catch (error) {
                showAlert('Ошибка загрузки настроек формы', 'error');
            }
        }
        
        // Сохранение конфигурации формы
        async function saveFormConfig() {
            if (!currentEditingForm) return;
            
            const config = {
                title: document.getElementById('configTitle').value,
                description: document.getElementById('configDescription').value,
                color: document.getElementById('configColor').value,
                footer: document.getElementById('configFooter').value,
                mentions: document.getElementById('configMentions').value
            };
            
            try {
                const response = await fetch(\`/admin/forms/\${currentEditingForm}/config\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config),
                    credentials: 'include'
                });
                
                if (response.status === 401) {
                    window.location.href = '/admin/login';
                    return;
                }
                
                const result = await response.json();
                
                if (result.status === 'success') {
                    showAlert('Настройки сохранены!', 'success');
                    hideConfigModal();
                    loadForms();
                } else {
                    showAlert(result.message, 'error');
                }
            } catch (error) {
                showAlert('Ошибка сохранения настроек', 'error');
            }
        }
        
        // Сброс настроек
        function resetFormConfig() {
            if (!confirm('Сбросить все настройки к значениям по умолчанию?')) return;
            
            document.getElementById('configTitle').value = '';
            document.getElementById('configDescription').value = '';
            document.getElementById('configColor').value = '#5865f2';
            document.getElementById('configColorText').textContent = '#5865f2';
            document.getElementById('configFooter').value = '';
            document.getElementById('configMentions').value = '';
            
            updatePreview();
        }
        
        // Скрыть модальное окно
        function hideConfigModal() {
            document.getElementById('configModal').style.display = 'none';
            currentEditingForm = null;
        }
        
        // Обновление предпросмотра
        function updatePreview() {
            const title = document.getElementById('configTitle').value || 'Название формы';
            const footer = document.getElementById('configFooter').value || 'Яндекс Формы';
            const color = document.getElementById('configColor').value;
            
            document.getElementById('previewTitle').textContent = title;
            document.getElementById('previewFooter').textContent = footer;
            document.getElementById('previewTitle').style.color = color;
        }
        
        // Слушатели событий для предпросмотра
        document.getElementById('configTitle').addEventListener('input', updatePreview);
        document.getElementById('configFooter').addEventListener('input', updatePreview);
        document.getElementById('configColor').addEventListener('input', function() {
            document.getElementById('configColorText').textContent = this.value;
            updatePreview();
        });
        
        // Тестирование вебхука
        async function testWebhook() {
            const formId = document.getElementById('testFormId').value;
            if (!formId) {
                showAlert('Выберите форму для тестирования', 'error');
                return;
            }
            
            await testSpecificForm(formId);
        }
        
        async function testSpecificForm(formId) {
            try {
                const response = await fetch(\`/admin/test-webhook/\${formId}\`, { 
                    method: 'POST',
                    credentials: 'include'
                });
                
                if (response.status === 401) {
                    window.location.href = '/admin/login';
                    return;
                }
                
                const result = await response.json();
                
                if (result.status === 'success') {
                    showAlert('✅ Тестовое сообщение отправлено в Discord!', 'success');
                } else {
                    showAlert(result.message, 'error');
                }
            } catch (error) {
                showAlert('Ошибка при тестировании вебхука', 'error');
            }
        }
        
        // Переключение вкладок
        function showTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            document.getElementById(tabName).classList.add('active');
            
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            event.target.classList.add('active');
            
            if (tabName === 'logs') {
                loadLogs();
            }
        }
        
        // Копирование Webhook URL
        function copyWebhookUrl() {
            const urlElement = document.getElementById('webhookUrlText');
            navigator.clipboard.writeText(urlElement.textContent);
            showAlert('URL скопирован в буфер обмена!', 'success');
        }
        
        // Загрузка логов
        async function loadLogs() {
            try {
                const response = await fetch('/admin/logs', {
                    credentials: 'include'
                });
                
                if (response.status === 401) {
                    window.location.href = '/admin/login';
                    return;
                }
                
                const logs = await response.text();
                document.getElementById('logsContent').textContent = logs || 'Логи пусты';
            } catch (error) {
                document.getElementById('logsContent').textContent = 'Ошибка загрузки логов';
            }
        }
        
        // Очистка логов
        async function clearLogs() {
            if (!confirm('Вы уверены, что хотите очистить все логи?')) return;
            
            try {
                const response = await fetch('/admin/logs', { 
                    method: 'DELETE',
                    credentials: 'include'
                });
                
                if (response.status === 401) {
                    window.location.href = '/admin/login';
                    return;
                }
                
                const result = await response.json();
                
                if (result.status === 'success') {
                    showAlert(result.message, 'success');
                    loadLogs();
                } else {
                    showAlert(result.message, 'error');
                }
            } catch (error) {
                showAlert('Ошибка при очистке логов', 'error');
            }
        }
        
        // Выход из системы
        async function logout() {
            try {
                const response = await fetch('/admin/logout', { 
                    method: 'POST',
                    credentials: 'include'
                });
                window.location.href = '/admin/login';
            } catch (error) {
                window.location.href = '/admin/login';
            }
        }
        
        // Вспомогательные функции
        function showAlert(message, type) {
            const alert = document.getElementById('alert');
            alert.textContent = message;
            alert.className = \`alert alert-\${type}\`;
            alert.classList.remove('hidden');
            
            const icon = type === 'success' ? 'fa-check-circle' : 
                        type === 'warning' ? 'fa-exclamation-triangle' : 'fa-exclamation-circle';
            alert.innerHTML = \`<i class="fas \${icon}"></i> \${message}\`;
            
            setTimeout(() => {
                alert.classList.add('hidden');
            }, 5000);
        }
        
        // Инициализация при загрузке
        document.addEventListener('DOMContentLoaded', function() {
            document.getElementById('webhookUrlText').textContent = window.location.origin + '/webhook/yandex-form';
            loadForms();
        });
    </script>
</body>
</html>
`;

// Инициализация при запуске
initializeDatabase().then(database => {
    db = database;
    
    // Основной вебхук для Яндекс Форм (GET запрос)
    app.get('/webhook/yandex-form', async (req, res) => {
        try {
            console.log('📨 Получен GET запрос от Яндекс Формы');
            
            // Логируем все параметры для отладки
            console.log('Query параметры:', req.query);
            
            // Извлекаем данные из GET параметров
            const { formId, formTitle, answers } = req.query;
            
            if (!formId) {
                await logRequest('UNKNOWN', 'ERROR', 'Отсутствует formId в GET параметрах');
                return res.status(400).json({
                    status: 'error',
                    message: 'Неверный формат данных: отсутствует formId'
                });
            }

            // Парсим answers если они есть
            let parsedAnswers = [];
            if (answers) {
                try {
                    parsedAnswers = JSON.parse(decodeURIComponent(answers));
                } catch (e) {
                    console.error('Ошибка парсинга answers:', e);
                    // Пробуем альтернативный формат - массив ответов
                    try {
                        if (Array.isArray(req.query)) {
                            parsedAnswers = Object.entries(req.query)
                                .filter(([key, value]) => key.startsWith('answers['))
                                .map(([key, value]) => ({
                                    question_id: key.match(/answers\[(.*?)\]/)?.[1] || key,
                                    text: value
                                }));
                        }
                    } catch (e2) {
                        console.error('Альтернативный парсинг тоже не удался:', e2);
                    }
                }
            }

            // Если answers не распарсились, пробуем найти ответы в других параметрах
            if (parsedAnswers.length === 0) {
                parsedAnswers = Object.entries(req.query)
                    .filter(([key, value]) => key !== 'formId' && key !== 'formTitle' && key !== 'answers')
                    .map(([key, value]) => ({
                        question_id: key,
                        text: value
                    }));
            }

            console.log('Распарсенные ответы:', parsedAnswers);

            // Ищем конфигурацию формы
            db.get(
                `SELECT form_name, webhook_url, title, description, color, footer, mentions 
                 FROM forms WHERE form_id = ?`,
                [formId],
                async (err, formConfig) => {
                    if (err) {
                        console.error('Ошибка поиска формы:', err);
                        await logRequest(formId, 'ERROR', 'Ошибка базы данных');
                        return res.status(500).json({
                            status: 'error',
                            message: 'Внутренняя ошибка сервера'
                        });
                    }
                    
                    if (!formConfig) {
                        console.warn(`❌ Не найден вебхук для формы: ${formId}`);
                        await logRequest(formId, 'NOT_FOUND', 'Форма не зарегистрирована');
                        return res.status(404).json({
                            status: 'error',
                            message: `Вебхук для формы ${formId} не зарегистрирован`
                        });
                    }

                    try {
                        // Создаем структуру данных
                        const formData = {
                            id: formId,
                            title: formTitle || formConfig.form_name
                        };

                        // Создаем вопросы на основе ответов
                        const questions = parsedAnswers.map((answer, index) => ({
                            id: answer.question_id || `q${index + 1}`,
                            text: `Вопрос ${index + 1}`
                        }));

                        // Отправляем в Discord
                        await sendDiscordMessage(formConfig, formData, questions, parsedAnswers);

                        console.log(`✅ Данные формы "${formConfig.form_name}" отправлены в Discord`);
                        await logRequest(formId, 'SENT', `Данные отправлены в Discord через GET`);

                        res.json({
                            status: 'success',
                            message: `Данные отправлены в Discord`,
                            formName: formConfig.form_name
                        });
                    } catch (error) {
                        console.error('❌ Ошибка отправки в Discord:', error);
                        await logRequest(formId, 'DISCORD_ERROR', error.message);
                        res.status(500).json({
                            status: 'error',
                            message: 'Ошибка отправки в Discord: ' + error.message
                        });
                    }
                }
            );

        } catch (error) {
            console.error('❌ Ошибка обработки GET вебхука:', error);
            logRequest(req.query.formId || 'UNKNOWN', 'ERROR', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Внутренняя ошибка сервера: ' + error.message
            });
        }
    });

    // Старый POST вебхук для обратной совместимости
    app.post('/webhook/yandex-form', async (req, res) => {
        try {
            console.log('📨 Получен POST запрос от Яндекс Формы');
            console.log('Body:', req.body);

            const { form, questions, answers } = req.body;

            if (!form || !form.id) {
                await logRequest('UNKNOWN', 'ERROR', 'Неверный формат данных в POST');
                return res.status(400).json({
                    status: 'error',
                    message: 'Неверный формат данных'
                });
            }

            const formId = form.id;
            
            db.get(
                `SELECT form_name, webhook_url, title, description, color, footer, mentions 
                 FROM forms WHERE form_id = ?`,
                [formId],
                async (err, formConfig) => {
                    if (err) {
                        console.error('Ошибка поиска формы:', err);
                        await logRequest(formId, 'ERROR', 'Ошибка базы данных');
                        return res.status(500).json({
                            status: 'error',
                            message: 'Внутренняя ошибка сервера'
                        });
                    }
                    
                    if (!formConfig) {
                        console.warn(`❌ Не найден вебхук для формы: ${formId}`);
                        await logRequest(formId, 'NOT_FOUND', 'Форма не зарегистрирована');
                        return res.status(404).json({
                            status: 'error',
                            message: `Вебхук для формы ${formId} не зарегистрирован`
                        });
                    }

                    try {
                        await sendDiscordMessage(formConfig, form, questions || [], answers || []);

                        console.log(`✅ Данные формы "${formConfig.form_name}" отправлены в Discord`);
                        await logRequest(formId, 'SENT', `Данные отправлены в Discord через POST`);

                        res.json({
                            status: 'success',
                            message: `Данные отправлены в Discord`,
                            formName: formConfig.form_name
                        });
                    } catch (error) {
                        console.error('❌ Ошибка отправки в Discord:', error);
                        await logRequest(formId, 'DISCORD_ERROR', error.message);
                        res.status(500).json({
                            status: 'error',
                            message: 'Ошибка отправки в Discord'
                        });
                    }
                }
            );

        } catch (error) {
            console.error('❌ Ошибка обработки POST вебхука:', error);
            logRequest(req.body.form?.id || 'UNKNOWN', 'ERROR', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Внутренняя ошибка сервера'
            });
        }
    });

    // Маршруты аутентификации
    app.get('/admin/login', (req, res) => {
        if (req.session.authenticated) {
            res.redirect('/admin');
        } else {
            res.send(LOGIN_HTML);
        }
    });

    app.post('/admin/login', (req, res) => {
        const { username, password } = req.body;
        
        db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
            if (err) {
                return res.status(500).json({ status: 'error', message: 'Ошибка базы данных' });
            }
            
            if (!user) {
                return res.status(401).json({ status: 'error', message: 'Неверный логин или пароль' });
            }
            
            bcrypt.compare(password, user.password_hash, (err, result) => {
                if (err) {
                    return res.status(500).json({ status: 'error', message: 'Ошибка проверки пароля' });
                }
                
                if (result) {
                    req.session.authenticated = true;
                    req.session.username = username;
                    res.json({ status: 'success', message: 'Вход выполнен' });
                } else {
                    res.status(401).json({ status: 'error', message: 'Неверный логин или пароль' });
                }
            });
        });
    });

    app.post('/admin/logout', (req, res) => {
        req.session.destroy((err) => {
            if (err) {
                console.error('Ошибка выхода:', err);
            }
            res.json({ status: 'success', message: 'Выход выполнен' });
        });
    });

    // Главная страница админки
    app.get('/admin', requireAuth, (req, res) => {
        res.send(ADMIN_HTML);
    });

    // API маршруты для админки
    app.get('/admin/forms', requireAuth, (req, res) => {
        db.all(
            `SELECT form_id as formId, form_name as formName, webhook_url as webhookUrl, 
                    mentions, created_at as createdAt 
             FROM forms ORDER BY created_at DESC`,
            (err, rows) => {
                if (err) {
                    console.error('Ошибка получения форм:', err);
                    return res.status(500).json({ status: 'error', message: 'Ошибка сервера' });
                }
                
                const forms = rows.map(form => ({
                    ...form,
                    webhookPreview: form.webhookUrl ? form.webhookUrl.substring(0, 50) + '...' : 'Не указан'
                }));

                res.json({
                    status: 'success',
                    total: forms.length,
                    forms
                });
            }
        );
    });

    app.get('/admin/forms/:formId/config', requireAuth, (req, res) => {
        const { formId } = req.params;
        
        db.get(
            `SELECT title, description, color, footer, mentions 
             FROM forms WHERE form_id = ?`,
            [formId],
            (err, row) => {
                if (err) {
                    console.error('Ошибка получения конфигурации:', err);
                    return res.status(500).json({ status: 'error', message: 'Ошибка сервера' });
                }
                
                if (!row) {
                    return res.status(404).json({ status: 'error', message: 'Форма не найдена' });
                }

                res.json({
                    status: 'success',
                    config: {
                        title: row.title || '',
                        description: row.description || '',
                        color: row.color || '#5865f2',
                        footer: row.footer || '',
                        mentions: row.mentions || ''
                    }
                });
            }
        );
    });

    app.put('/admin/forms/:formId/config', requireAuth, (req, res) => {
        const { formId } = req.params;
        const config = req.body;
        
        db.run(
            `UPDATE forms SET 
                title = ?, description = ?, color = ?, footer = ?, mentions = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE form_id = ?`,
            [config.title, config.description, config.color, config.footer, config.mentions, formId],
            function(err) {
                if (err) {
                    console.error('Ошибка сохранения конфигурации:', err);
                    return res.status(500).json({ status: 'error', message: 'Ошибка сервера' });
                }
                
                if (this.changes === 0) {
                    return res.status(404).json({ status: 'error', message: 'Форма не найдена' });
                }

                logRequest(formId, 'CONFIG_UPDATED', 'Конфигурация обновлена');
                
                res.json({
                    status: 'success',
                    message: 'Настройки сохранены'
                });
            }
        );
    });

    app.post('/admin/register-form', requireAuth, (req, res) => {
        const { formId, formName, discordWebhookUrl } = req.body;

        if (!formId || !formName || !discordWebhookUrl) {
            return res.status(400).json({
                status: 'error',
                message: 'formId, formName и discordWebhookUrl обязательны'
            });
        }

        if (!isValidWebhookUrl(discordWebhookUrl)) {
            return res.status(400).json({
                status: 'error',
                message: 'Неверный Discord Webhook URL. Должен начинаться с https://discord.com/api/webhooks/'
            });
        }

        db.run(
            `INSERT INTO forms (form_id, form_name, webhook_url) 
             VALUES (?, ?, ?)`,
            [formId, formName, discordWebhookUrl],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint failed')) {
                        return res.status(400).json({
                            status: 'error',
                            message: `Форма с ID ${formId} уже зарегистрирована`
                        });
                    }
                    console.error('Ошибка регистрации формы:', err);
                    return res.status(500).json({
                        status: 'error',
                        message: 'Внутренняя ошибка сервера'
                    });
                }

                console.log(`✅ Зарегистрирована форма: ${formId} - ${formName}`);
                logRequest(formId, 'REGISTERED', `Форма "${formName}" зарегистрирована`);

                res.json({
                    status: 'success',
                    message: `Форма "${formName}" успешно зарегистрирована`,
                    formId: formId
                });
            }
        );
    });

    app.delete('/admin/forms/:formId', requireAuth, (req, res) => {
        const { formId } = req.params;
        
        db.get('SELECT form_name FROM forms WHERE form_id = ?', [formId], (err, row) => {
            if (err) {
                console.error('Ошибка поиска формы:', err);
                return res.status(500).json({ status: 'error', message: 'Ошибка сервера' });
            }
            
            if (!row) {
                return res.status(404).json({ status: 'error', message: `Форма ${formId} не найдена` });
            }

            const formName = row.form_name;
            
            db.run('DELETE FROM forms WHERE form_id = ?', [formId], function(err) {
                if (err) {
                    console.error('Ошибка удаления формы:', err);
                    return res.status(500).json({ status: 'error', message: 'Ошибка сервера' });
                }
                
                console.log(`🗑️ Удалена форма: ${formId} - ${formName}`);
                logRequest(formId, 'DELETED', `Форма "${formName}" удалена`);
                
                res.json({ status: 'success', message: `Форма "${formName}" удалена` });
            });
        });
    });

    app.post('/admin/test-webhook/:formId', requireAuth, (req, res) => {
        const { formId } = req.params;
        
        db.get(
            `SELECT form_name, webhook_url, title, description, color, footer, mentions 
             FROM forms WHERE form_id = ?`,
            [formId],
            (err, formConfig) => {
                if (err) {
                    console.error('Ошибка поиска формы:', err);
                    return res.status(500).json({ status: 'error', message: 'Ошибка сервера' });
                }
                
                if (!formConfig) {
                    return res.status(404).json({ status: 'error', message: `Форма ${formId} не найдена` });
                }

                // Создаем тестовые данные
                const testData = {
                    form: { id: formId, title: formConfig.form_name },
                    questions: [
                        { id: 'q1', text: 'Ваш Discord ID' },
                        { id: 'q2', text: 'Ваше имя' },
                        { id: 'q3', text: 'Сообщение' }
                    ],
                    answers: [
                        { question_id: 'q1', text: '123456789012345678' },
                        { question_id: 'q2', text: 'Тестовый пользователь' },
                        { question_id: 'q3', text: 'Это тестовое сообщение из панели управления' }
                    ]
                };

                sendDiscordMessage(formConfig, testData.form, testData.questions, testData.answers)
                    .then(() => {
                        logRequest(formId, 'TEST', 'Тестовое сообщение отправлено');
                        res.json({ status: 'success', message: 'Тестовое сообщение отправлено в Discord' });
                    })
                    .catch(error => {
                        console.error('Ошибка тестирования вебхука:', error);
                        logRequest(formId, 'TEST_ERROR', error.message);
                        res.status(500).json({ status: 'error', message: 'Ошибка отправки тестового сообщения' });
                    });
            }
        );
    });

    app.get('/admin/logs', requireAuth, (req, res) => {
        db.all(
            `SELECT form_id, status, message, timestamp 
             FROM logs ORDER BY timestamp DESC LIMIT 100`,
            (err, rows) => {
                if (err) {
                    console.error('Ошибка получения логов:', err);
                    return res.status(500).send('Ошибка чтения логов');
                }
                
                const logs = rows.map(log => 
                    `[${log.timestamp}] FORM:${log.form_id || 'SYSTEM'} STATUS:${log.status} ${log.message || ''}`
                ).join('\n');
                
                res.set('Content-Type', 'text/plain');
                res.send(logs);
            }
        );
    });

    app.delete('/admin/logs', requireAuth, (req, res) => {
        db.run('DELETE FROM logs', function(err) {
            if (err) {
                console.error('Ошибка очистки логов:', err);
                return res.status(500).json({ status: 'error', message: 'Ошибка очистки логов' });
            }
            
            logRequest('SYSTEM', 'LOGS_CLEARED', 'Логи очищены через админку');
            res.json({ status: 'success', message: 'Логи очищены' });
        });
    });

    // Health check
    app.get('/health', (req, res) => {
        res.json({ 
            status: 'healthy', 
            timestamp: new Date().toISOString(),
            version: '4.4',
            note: 'Умные упоминания: пользователь в сообщении, роль сверху'
        });
    });

    // Запуск сервера
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`
✨ 🚀 СЕРВЕР ЯНДЕКС ФОРМЫ → DISCORD ЗАПУЩЕН! ✨

📍 Порт: ${PORT}
📊 Админка: http://localhost:${PORT}/admin
🌐 Доступ извне: http://95.164.93.95:${PORT}/admin
🔐 Логин: admin / admin123

🎉 ОСНОВНЫЕ ВОЗМОЖНОСТИ ВЕРСИИ 4.4:
✅ УМНЫЕ УПОМИНАНИЯ: пользователь в сообщении, роль сверху
✅ ПОДДЕРЖКА GET ЗАПРОСОВ от нового интерфейса Яндекс Форм
✅ АВТОМАТИЧЕСКОЕ УПОМИНАНИЕ по Discord ID из первого поля
🔐 БЕЗОПАСНАЯ АУТЕНТИФИКАЦИЯ

⚡ СЕРВЕР ГОТОВ К РАБОТЕ!

💡 ВАЖНО: Смените пароль администратора в коде!
        `);
    });
}).catch(err => {
    console.error('❌ Ошибка инициализации базы данных:', err);
    process.exit(1);
});

// Обработка graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n📴 Завершение работы сервера...');
    await logRequest('SYSTEM', 'SHUTDOWN', 'Сервер остановлен');
    if (db) {
        db.close();
    }
    process.exit(0);
});