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
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

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
const MAX_QUESTIONS = 20;

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
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, (err) => {
                if (err) console.error('Ошибка создания таблицы users:', err);
            });

            db.run(`CREATE TABLE IF NOT EXISTS forms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                form_id TEXT UNIQUE NOT NULL,
                form_name TEXT NOT NULL,
                webhook_url TEXT NOT NULL,
                title TEXT DEFAULT '',
                description TEXT DEFAULT '',
                color TEXT DEFAULT '#5865f2',
                footer TEXT DEFAULT 'GTA5RP LAMESA',
                mentions TEXT DEFAULT '',
                question_titles TEXT DEFAULT '[]',
                discord_id_fields TEXT DEFAULT '["0"]',
                conditional_mentions TEXT DEFAULT '[]',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, (err) => {
                if (err) console.error('Ошибка создания таблицы forms:', err);
            });

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
            const defaultPassword = 'gta5rpLaMesa_Rayzaki100';
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
async function sendDiscordMessage(formConfig, formData, answers) {
    // Получаем поля с Discord ID
    let discordIdFields = [0]; // по умолчанию первый вопрос
    try {
        discordIdFields = JSON.parse(formConfig.discord_id_fields || '[0]');
    } catch (e) {
        console.error('Ошибка парсинга discord_id_fields:', e);
    }

    // Получаем условные упоминания
    let conditionalMentions = [];
    try {
        conditionalMentions = JSON.parse(formConfig.conditional_mentions || '[]');
    } catch (e) {
        console.error('Ошибка парсинга conditional_mentions:', e);
    }

    // Собираем Discord ID из указанных полей
    let discordIds = [];
    discordIdFields.forEach(fieldIndex => {
        if (answers[fieldIndex] && answers[fieldIndex].text) {
            let discordId = answers[fieldIndex].text.replace(/[^0-9]/g, '');
            if (discordId.length >= 17) {
                discordIds.push(discordId);
            }
        }
    });

    // Определяем упоминания на основе условий
    let mentionContent = '';
    let conditionalRoleIds = [];

    // Проверяем условия для упоминаний
    conditionalMentions.forEach(condition => {
        const { question_index, answer_value, role_id } = condition;
        if (answers[question_index] && answers[question_index].text && 
            answers[question_index].text.trim() === answer_value) {
            conditionalRoleIds.push(role_id);
        }
    });

    // Добавляем условные роли
    if (conditionalRoleIds.length > 0) {
        const conditionalMentions = conditionalRoleIds
            .map(id => id.trim())
            .filter(id => id.length >= 17)
            .map(id => `<@&${id}>`)
            .join(' ');
        
        if (conditionalMentions) {
            mentionContent += conditionalMentions + ' ';
        }
    }

    // Добавляем статические упоминания
    if (formConfig.mentions) {
        const additionalMentions = formConfig.mentions.split(',')
            .map(id => id.trim())
            .filter(id => id.length >= 17)
            .map(id => `<@&${id}>`)
            .join(' ');
        
        if (additionalMentions) {
            mentionContent += additionalMentions + ' ';
        }
    }

    // Добавляем упоминания пользователей
    if (discordIds.length > 0) {
        const userMentions = discordIds.map(id => `<@${id}>`).join(' ');
        mentionContent += userMentions;
    }

    // Убираем лишние пробелы
    mentionContent = mentionContent.trim();

    const embed = {
        title: formConfig.title || `📋 ${formData.title || formConfig.form_name}`,
        description: formConfig.description || null,
        color: parseInt((formConfig.color || '#5865f2').replace('#', ''), 16),
        fields: [],
        timestamp: new Date().toISOString(),
        footer: formConfig.footer ? { text: formConfig.footer } : { text: 'GTA5RP LAMESA' }
    };

    // Получаем кастомные названия вопросов
    let questionTitles = [];
    try {
        questionTitles = JSON.parse(formConfig.question_titles || '[]');
    } catch (e) {
        console.error('Ошибка парсинга question_titles:', e);
    }

    const limitedAnswers = answers.slice(0, MAX_QUESTIONS);

    limitedAnswers.forEach((answer, index) => {
        if (answer.text) {
            const isDiscordIdField = discordIdFields.includes(index);
            
            // Используем кастомное название вопроса или генерируем стандартное
            const questionText = questionTitles[index] || `Вопрос ${index + 1}`;
            
            if (isDiscordIdField) {
                const discordId = answer.text.replace(/[^0-9]/g, '');
                if (discordId.length >= 17) {
                    embed.fields.push({
                        name: questionText,
                        value: `<@${discordId}>` + (discordIdFields.length > 1 ? ` 👆 Упоминание ${discordIdFields.indexOf(index) + 1}` : ' 👆 Упоминание'),
                        inline: false
                    });
                } else {
                    embed.fields.push({
                        name: questionText,
                        value: answer.text,
                        inline: false
                    });
                }
            } else {
                const fieldValue = answer.text.length > 1024 ? 
                    answer.text.substring(0, 1020) + '...' : answer.text;
                
                embed.fields.push({
                    name: questionText,
                    value: fieldValue,
                    inline: false
                });
            }
        }
    });

    if (answers.length > MAX_QUESTIONS) {
        embed.fields.push({
            name: '📝 Примечание',
            value: `Показаны первые ${MAX_QUESTIONS} из ${answers.length} вопросов. Остальные вопросы не были включены из-за ограничений Discord.`,
            inline: false
        });
    }

    if (embed.fields.length === 0) {
        embed.fields.push({
            name: '📝 Информация',
            value: 'Нет данных для отображения',
            inline: false
        });
    }

    const payload = {
        embeds: [embed]
    };

    if (mentionContent) {
        payload.content = mentionContent;
    }

    const response = await axios.post(formConfig.webhook_url, payload);
    return response.data;
}

// Функция для парсинга ответов
function parseYandexFormAnswers(answersData) {
    try {
        if (Array.isArray(answersData)) {
            return answersData;
        }

        if (typeof answersData === 'string') {
            const parsed = JSON.parse(answersData);
            return parseYandexFormAnswers(parsed);
        }

        if (answersData && answersData.answer && answersData.answer.data) {
            const answers = [];
            const data = answersData.answer.data;
            
            Object.keys(data).forEach(key => {
                const field = data[key];
                if (field && field.value !== undefined) {
                    let answerText = field.value;
                    
                    if (Array.isArray(answerText)) {
                        answerText = answerText.map(item => item.text || item).join(', ');
                    } else if (typeof answerText === 'object') {
                        answerText = JSON.stringify(answerText);
                    }
                    
                    answers.push({
                        question_id: key,
                        text: String(answerText)
                    });
                }
            });
            
            return answers;
        }

        if (answersData && typeof answersData === 'object') {
            const answers = [];
            Object.keys(answersData).forEach(key => {
                if (key !== 'formId' && key !== 'formTitle') {
                    answers.push({
                        question_id: key,
                        text: String(answersData[key])
                    });
                }
            });
            return answers;
        }

        return [];
    } catch (error) {
        console.error('Ошибка парсинга ответов:', error);
        return [];
    }
}

let db;

// POST вебхук для Яндекс Форм
app.post('/webhook/yandex-form', async (req, res) => {
    try {
        console.log('📨 Получен POST запрос от Яндекс Формы');
        
        let requestBody = req.body;
        
        let formId, formTitle, answers;

        // Обработка JSON-RPC запроса
        if (requestBody && requestBody.jsonrpc === '2.0') {
            console.log('🔧 Обработка JSON-RPC запроса');
            
            const { method, params, id } = requestBody;
            
            formId = params.formId;
            formTitle = params.formTitle;
            
            if (params.answers) {
                if (typeof params.answers === 'string') {
                    try {
                        const answersData = JSON.parse(params.answers);
                        answers = parseYandexFormAnswers(answersData);
                    } catch (e) {
                        console.error('Ошибка парсинга answers в JSON-RPC:', e);
                        answers = [];
                    }
                } else {
                    answers = parseYandexFormAnswers(params.answers);
                }
            } else {
                answers = [];
            }

            db.get(
                `SELECT form_name, webhook_url, title, description, color, footer, mentions, question_titles, discord_id_fields, conditional_mentions
                 FROM forms WHERE form_id = ?`,
                [formId],
                async (err, formConfig) => {
                    if (err) {
                        console.error('Ошибка поиска формы:', err);
                        await logRequest(formId, 'ERROR', 'Ошибка базы данных');
                        return res.json({
                            jsonrpc: '2.0',
                            error: { code: -32603, message: 'Internal error' },
                            id: id
                        });
                    }
                    
                    if (!formConfig) {
                        console.warn(`❌ Не найден вебхук для формы: ${formId}`);
                        await logRequest(formId, 'NOT_FOUND', 'Форма не зарегистрирована');
                        return res.json({
                            jsonrpc: '2.0',
                            error: { code: -32601, message: `Вебхук для формы ${formId} не зарегистрирован` },
                            id: id
                        });
                    }

                    try {
                        const formData = {
                            id: formId,
                            title: formTitle || formConfig.form_name
                        };

                        await sendDiscordMessage(formConfig, formData, answers);

                        console.log(`✅ Данные формы "${formConfig.form_name}" отправлены в Discord через JSON-RPC`);
                        await logRequest(formId, 'SENT', `Данные отправлены в Discord через JSON-RPC`);

                        res.json({
                            jsonrpc: '2.0',
                            result: { 
                                status: 'success',
                                message: `Данные отправлены в Discord`,
                                formName: formConfig.form_name
                            },
                            id: id
                        });
                    } catch (error) {
                        console.error('❌ Ошибка отправки в Discord:', error);
                        await logRequest(formId, 'DISCORD_ERROR', error.message);
                        res.json({
                            jsonrpc: '2.0',
                            error: { code: -32000, message: 'Ошибка отправки в Discord: ' + error.message },
                            id: id
                        });
                    }
                }
            );
            return;
        }

        // Обработка обычного POST запроса
        if (requestBody && requestBody.form && requestBody.form.id) {
            console.log('🔧 Обработка обычного POST запроса');
            
            formId = requestBody.form.id;
            formTitle = requestBody.form.title;
            answers = requestBody.answers || [];
        } else {
            formId = requestBody.formId || requestBody.form_id;
            formTitle = requestBody.formTitle || requestBody.form_title;
            
            if (requestBody.answers) {
                answers = parseYandexFormAnswers(requestBody.answers);
            } else {
                answers = Object.entries(requestBody)
                    .filter(([key, value]) => !['formId', 'form_id', 'formTitle', 'form_title', 'answers'].includes(key))
                    .map(([key, value]) => ({
                        question_id: key,
                        text: String(value)
                    }));
            }
        }

        if (!formId) {
            await logRequest('UNKNOWN', 'ERROR', 'Неверный формат данных в POST');
            return res.status(400).json({
                status: 'error',
                message: 'Неверный формат данных: отсутствует formId'
            });
        }

        db.get(
            `SELECT form_name, webhook_url, title, description, color, footer, mentions, question_titles, discord_id_fields, conditional_mentions
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
                    const formData = {
                        id: formId,
                        title: formTitle || formConfig.form_name
                    };

                    await sendDiscordMessage(formConfig, formData, answers);

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
        console.error('❌ Ошибка обработка POST вебхука:', error);
        logRequest('UNKNOWN', 'ERROR', error.message);
        res.status(500).json({
            status: 'error',
            message: 'Внутренняя ошибка сервера'
        });
    }
});

// HTML страница входа
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

// HTML админки с расширенными настройками
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

        .question-title-item {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
            padding: 10px;
            background: #2f3136;
            border-radius: 4px;
        }

        .question-title-item input {
            flex: 1;
        }

        .question-title-item .btn {
            padding: 8px 12px;
        }

        .maintenance-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.8);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }
        
        .maintenance-content {
            background: #36393f;
            border-radius: 8px;
            padding: 2rem;
            max-width: 500px;
            width: 95%;
            border: 1px solid #40444b;
        }

        .discord-id-field-item {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
            padding: 10px;
            background: #2f3136;
            border-radius: 4px;
        }

        .conditional-mention-item {
            background: #2f3136;
            border-radius: 4px;
            padding: 15px;
            margin-bottom: 15px;
            border: 1px solid #40444b;
        }

        .conditional-mention-header {
            display: flex;
            justify-content: between;
            align-items: center;
            margin-bottom: 10px;
        }

        .conditional-mention-content {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 10px;
        }

        @media (max-width: 768px) {
            .conditional-mention-content {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-bar">
            <div class="header">
                <h1><i class="fab fa-discord"></i> Яндекс Формы → Discord</h1>
                <p>Расширенные настройки: несколько Discord ID + условные упоминания</p>
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
                <div class="stat-number">${MAX_QUESTIONS}</div>
                <div>Макс. вопросов</div>
            </div>
        </div>

        <div class="info-box">
            <h4><i class="fas fa-info-circle"></i> Расширенная логика работы</h4>
            <p><strong>Несколько Discord ID:</strong> можно указать несколько полей для упоминания разных пользователей</p>
            <p><strong>Условные упоминания:</strong> тегить разные роли в зависимости от ответов в форме</p>
            <p><strong>Гибкие настройки:</strong> для каждой формы можно настроить индивидуальное поведение</p>
            <p><strong>Ограничение:</strong> до ${MAX_QUESTIONS} вопросов</p>
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
                            <label>Уведомления</label>
                            <button onclick="showMaintenanceModal()" class="btn btn-warning btn-block">
                                <i class="fas fa-tools"></i> Уведомление о тех. работах
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

                    <div class="info-box">
                        <h4><i class="fas fa-info-circle"></i> Настройки для Яндекс Форм</h4>
                        <p><strong>URL:</strong> http://ваш_сервер:${PORT}/webhook/yandex-form</p>
                        <p><strong>Метод:</strong> POST</p>
                        <p><strong>Тип содержимого:</strong> application/json</p>
                        <p><strong>Тело запроса (JSON-RPC):</strong></p>
                        <div class="mention-example">
{
  "jsonrpc": "2.0",
  "method": "submitForm",
  "params": {
    "formId": "{formId}",
    "formTitle": "{formTitle}",
    "answers": {answers | JSON}
  },
  "id": 1
}
                        </div>
                        <p><strong>Или тело запроса (обычный JSON):</strong></p>
                        <div class="mention-example">
{
  "formId": "{formId}",
  "formTitle": "{formTitle}",
  "answers": {answers | JSON}
}
                        </div>
                        <p><strong>Важно:</strong> Используйте фильтр JSON для переменной <code>answers</code></p>
                        <p><strong>Ограничение:</strong> максимум ${MAX_QUESTIONS} вопросов</p>
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
        <div class="discord-card" style="max-width: 900px; width: 95%; max-height: 90vh; overflow-y: auto;">
            <h2><i class="fas fa-sliders-h"></i> Расширенные настройки формы</h2>
            <p>Настройте как будут выглядеть сообщения из этой формы в Discord</p>
            
            <div class="info-box">
                <h4><i class="fas fa-at"></i> Новая расширенная логика</h4>
                <p><strong>Несколько Discord ID:</strong> можно указать несколько полей для упоминания</p>
                <p><strong>Условные упоминания:</strong> тегить роли в зависимости от ответов</p>
                <p><strong>Гибкие настройки:</strong> индивидуальное поведение для каждой формы</p>
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
                    <input type="text" id="configFooter" value="GTA5RP LAMESA" placeholder="Например: GTA5RP LAMESA">
                </div>
            </div>

            <div class="config-section">
                <h3><i class="fas fa-at"></i> Упоминания</h3>
                
                <div class="form-group">
                    <label for="configMentions">Статические упоминания ролей (ID через запятую)</label>
                    <input type="text" id="configMentions" placeholder="123456789012345678,987654321098765432">
                    <div class="mention-example">
                        Пример: 123456789012345678,987654321098765432<br>
                        Роли будут упомянуты: &lt;@&123456789012345678&gt; &lt;@&987654321098765432&gt;
                    </div>
                </div>
            </div>

            <div class="config-section">
                <h3><i class="fas fa-id-card"></i> Поля с Discord ID</h3>
                <p style="margin-bottom: 1rem; font-size: 0.9rem; color: #b9bbbe;">
                    Укажите номера вопросов (начиная с 0), которые содержат Discord ID для упоминания пользователей
                </p>
                
                <div id="discordIdFieldsContainer">
                    <!-- Динамически добавляемые поля для Discord ID -->
                </div>
                
                <button type="button" onclick="addDiscordIdField()" class="btn btn-secondary">
                    <i class="fas fa-plus"></i> Добавить поле Discord ID
                </button>
            </div>

            <div class="config-section">
                <h3><i class="fas fa-random"></i> Условные упоминания</h3>
                <p style="margin-bottom: 1rem; font-size: 0.9rem; color: #b9bbbe;">
                    Настройте упоминания ролей в зависимости от ответов в форме
                </p>
                
                <div id="conditionalMentionsContainer">
                    <!-- Динамически добавляемые условные упоминания -->
                </div>
                
                <button type="button" onclick="addConditionalMention()" class="btn btn-secondary">
                    <i class="fas fa-plus"></i> Добавить условие
                </button>
            </div>

            <div class="config-section">
                <h3><i class="fas fa-question-circle"></i> Названия вопросов</h3>
                <p style="margin-bottom: 1rem; font-size: 0.9rem; color: #b9bbbe;">
                    Задайте названия для вопросов
                </p>
                
                <div id="questionTitlesContainer">
                    <!-- Динамически добавляемые поля для вопросов -->
                </div>
                
                <button type="button" onclick="addQuestionTitleField()" class="btn btn-secondary">
                    <i class="fas fa-plus"></i> Добавить вопрос
                </button>
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
                        <div class="name" id="previewQuestion1">Discord ID 1</div>
                        <div>&lt;@123456789012345678&gt; 👆 Упоминание 1</div>
                    </div>
                    <div class="field">
                        <div class="name" id="previewQuestion2">Discord ID 2</div>
                        <div>&lt;@987654321098765432&gt; 👆 Упоминание 2</div>
                    </div>
                    <div class="field">
                        <div class="name" id="previewQuestion3">Вопрос 3</div>
                        <div>Ответ 3</div>
                    </div>
                    <div class="footer" id="previewFooter">GTA5RP LAMESA</div>
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

    <!-- Модальное окно тех работ -->
    <div id="maintenanceModal" class="maintenance-modal">
        <div class="maintenance-content">
            <h2><i class="fas fa-tools"></i> Уведомление о технических работах</h2>
            <p>Это сообщение будет отправлено на ВСЕ зарегистрированные вебхуки Discord.</p>
            
            <div class="form-group">
                <label for="maintenanceMessage">Сообщение</label>
                <textarea id="maintenanceMessage" rows="4" style="width: 100%; padding: 12px; background: #40444b; border: 1px solid #40444b; border-radius: 4px; color: #dcddde;">
⚡ Проводятся технические работы
В настоящее время проводятся технические работы. Пожалуйста, не заполняйте формы до окончания работ.

Приносим извинения за неудобства.
                </textarea>
            </div>

            <div style="display: flex; gap: 10px; margin-top: 1.5rem;">
                <button onclick="sendMaintenanceMessage()" class="btn btn-warning">
                    <i class="fas fa-paper-plane"></i> Отправить всем
                </button>
                <button onclick="hideMaintenanceModal()" class="btn btn-secondary">
                    <i class="fas fa-times"></i> Отмена
                </button>
            </div>

            <div id="maintenanceResults" style="margin-top: 1rem; max-height: 200px; overflow-y: auto; display: none;">
                <h4>Результаты отправки:</h4>
                <div id="maintenanceResultsContent" style="font-family: monospace; font-size: 12px;"></div>
            </div>
        </div>
    </div>

    <script>
        let currentEditingForm = null;

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
                    const formCard = document.createElement('div');
                    formCard.className = 'form-card';
                    formCard.innerHTML = \`
                        <h3><i class="fas fa-form"></i> \${form.formName}</h3>
                        <p><strong>ID:</strong> \${form.formId}</p>
                        <p><strong>Webhook:</strong> \${form.webhookPreview}</p>
                        <p><strong>Роли для упоминания:</strong> \${form.mentions || 'Не указаны'}</p>
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
        
        function addDiscordIdField(index = '') {
            const container = document.getElementById('discordIdFieldsContainer');
            const fieldHTML = \`
                <div class="discord-id-field-item">
                    <input type="number" 
                           class="discord-id-field-input" 
                           placeholder="Номер вопроса (0, 1, 2...)" 
                           value="\${index}"
                           min="0"
                           max="${MAX_QUESTIONS - 1}">
                    <button type="button" class="btn btn-danger" onclick="this.parentElement.remove(); updatePreview()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            \`;
            container.insertAdjacentHTML('beforeend', fieldHTML);
            updatePreview();
        }
        
        function addConditionalMention(condition = { question_index: '', answer_value: '', role_id: '' }) {
            const container = document.getElementById('conditionalMentionsContainer');
            const fieldHTML = \`
                <div class="conditional-mention-item">
                    <div class="conditional-mention-header">
                        <h4><i class="fas fa-random"></i> Условное упоминание</h4>
                        <button type="button" class="btn btn-danger" onclick="this.parentElement.parentElement.remove(); updatePreview()">
                            <i class="fas fa-times"></i> Удалить
                        </button>
                    </div>
                    <div class="conditional-mention-content">
                        <div>
                            <label>Номер вопроса</label>
                            <input type="number" 
                                   class="conditional-question-index" 
                                   placeholder="0, 1, 2..." 
                                   value="\${condition.question_index || ''}"
                                   min="0"
                                   max="${MAX_QUESTIONS - 1}">
                        </div>
                        <div>
                            <label>Значение ответа</label>
                            <input type="text" 
                                   class="conditional-answer-value" 
                                   placeholder="Точный текст ответа" 
                                   value="\${condition.answer_value || ''}">
                        </div>
                        <div>
                            <label>ID роли для упоминания</label>
                            <input type="text" 
                                   class="conditional-role-id" 
                                   placeholder="123456789012345678" 
                                   value="\${condition.role_id || ''}">
                        </div>
                    </div>
                </div>
            \`;
            container.insertAdjacentHTML('beforeend', fieldHTML);
            updatePreview();
        }
        
        function addQuestionTitleField(title = '') {
            const container = document.getElementById('questionTitlesContainer');
            const index = container.children.length + 1;
            const fieldHTML = \`
                <div class="question-title-item">
                    <input type="text" 
                           class="question-title-input" 
                           placeholder="Название вопроса \${index}" 
                           value="\${title}"
                           oninput="updatePreview()">
                    <button type="button" class="btn btn-danger" onclick="this.parentElement.remove(); updatePreview()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            \`;
            container.insertAdjacentHTML('beforeend', fieldHTML);
            updatePreview();
        }
        
        function loadDiscordIdFields(discordIdFields) {
            const container = document.getElementById('discordIdFieldsContainer');
            container.innerHTML = '';
            
            if (discordIdFields && discordIdFields.length > 0) {
                discordIdFields.forEach(index => {
                    addDiscordIdField(index);
                });
            } else {
                // Добавляем поле по умолчанию
                addDiscordIdField('0');
            }
        }
        
        function loadConditionalMentions(conditionalMentions) {
            const container = document.getElementById('conditionalMentionsContainer');
            container.innerHTML = '';
            
            if (conditionalMentions && conditionalMentions.length > 0) {
                conditionalMentions.forEach(condition => {
                    addConditionalMention(condition);
                });
            }
        }
        
        function loadQuestionTitles(questionTitles) {
            const container = document.getElementById('questionTitlesContainer');
            container.innerHTML = '';
            
            if (questionTitles && questionTitles.length > 0) {
                questionTitles.forEach(title => {
                    addQuestionTitleField(title);
                });
            } else {
                // Добавляем поля по умолчанию
                addQuestionTitleField('Discord ID 1');
                addQuestionTitleField('Discord ID 2');
                addQuestionTitleField('Дополнительная информация');
            }
        }
        
        function getDiscordIdFields() {
            const inputs = document.querySelectorAll('.discord-id-field-input');
            const fields = [];
            inputs.forEach(input => {
                if (input.value.trim() && !isNaN(input.value)) {
                    fields.push(parseInt(input.value.trim()));
                }
            });
            return fields.length > 0 ? fields : [0];
        }
        
        function getConditionalMentions() {
            const items = document.querySelectorAll('.conditional-mention-item');
            const mentions = [];
            items.forEach(item => {
                const questionIndex = item.querySelector('.conditional-question-index').value;
                const answerValue = item.querySelector('.conditional-answer-value').value;
                const roleId = item.querySelector('.conditional-role-id').value;
                
                if (questionIndex && answerValue && roleId) {
                    mentions.push({
                        question_index: parseInt(questionIndex),
                        answer_value: answerValue.trim(),
                        role_id: roleId.trim()
                    });
                }
            });
            return mentions;
        }
        
        function getQuestionTitles() {
            const inputs = document.querySelectorAll('.question-title-input');
            const titles = [];
            inputs.forEach(input => {
                if (input.value.trim()) {
                    titles.push(input.value.trim());
                }
            });
            return titles;
        }
        
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
                
                document.getElementById('configTitle').value = config.title || '';
                document.getElementById('configDescription').value = config.description || '';
                document.getElementById('configColor').value = config.color || '#5865f2';
                document.getElementById('configColorText').textContent = config.color || '#5865f2';
                document.getElementById('configFooter').value = config.footer || 'GTA5RP LAMESA';
                document.getElementById('configMentions').value = config.mentions || '';
                
                // Загружаем расширенные настройки
                loadDiscordIdFields(config.discord_id_fields || [0]);
                loadConditionalMentions(config.conditional_mentions || []);
                loadQuestionTitles(config.question_titles || []);
                
                updatePreview();
                
                document.getElementById('configModal').style.display = 'flex';
                
            } catch (error) {
                showAlert('Ошибка загрузки настроек формы', 'error');
            }
        }
        
        async function saveFormConfig() {
            if (!currentEditingForm) return;
            
            const discordIdFields = getDiscordIdFields();
            const conditionalMentions = getConditionalMentions();
            const questionTitles = getQuestionTitles();
            
            const config = {
                title: document.getElementById('configTitle').value,
                description: document.getElementById('configDescription').value,
                color: document.getElementById('configColor').value,
                footer: document.getElementById('configFooter').value,
                mentions: document.getElementById('configMentions').value,
                discord_id_fields: discordIdFields,
                conditional_mentions: conditionalMentions,
                question_titles: questionTitles
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
        
        function resetFormConfig() {
            if (!confirm('Сбросить все настройки к значениям по умолчанию?')) return;
            
            document.getElementById('configTitle').value = '';
            document.getElementById('configDescription').value = '';
            document.getElementById('configColor').value = '#5865f2';
            document.getElementById('configColorText').textContent = '#5865f2';
            document.getElementById('configFooter').value = 'GTA5RP LAMESA';
            document.getElementById('configMentions').value = '';
            
            loadDiscordIdFields([0]);
            loadConditionalMentions([]);
            loadQuestionTitles(['Discord ID 1', 'Discord ID 2', 'Дополнительная информация']);
            
            updatePreview();
        }
        
        function hideConfigModal() {
            document.getElementById('configModal').style.display = 'none';
            currentEditingForm = null;
        }
        
        function updatePreview() {
            const title = document.getElementById('configTitle').value || 'Название формы';
            const footer = document.getElementById('configFooter').value || 'GTA5RP LAMESA';
            const color = document.getElementById('configColor').value;
            const questionTitles = getQuestionTitles();
            const discordIdFields = getDiscordIdFields();
            
            document.getElementById('previewTitle').textContent = title;
            document.getElementById('previewFooter').textContent = footer;
            document.getElementById('previewTitle').style.color = color;
            
            // Обновляем названия вопросов в превью
            const previewQuestions = document.querySelectorAll('.embed-preview .field');
            previewQuestions.forEach((preview, index) => {
                const nameElement = preview.querySelector('.name');
                const valueElement = preview.querySelector('div:last-child');
                
                if (questionTitles[index]) {
                    nameElement.textContent = questionTitles[index];
                } else if (index === 0) {
                    nameElement.textContent = 'Discord ID 1';
                } else if (index === 1) {
                    nameElement.textContent = 'Discord ID 2';
                } else {
                    nameElement.textContent = \`Вопрос \${index + 1}\`;
                }
                
                // Обновляем значения для полей Discord ID
                if (discordIdFields.includes(index)) {
                    const mentionNumber = discordIdFields.indexOf(index) + 1;
                    valueElement.innerHTML = \`&lt;@\${123456789012345678 + index}&gt; 👆 Упоминание \${mentionNumber}\`;
                } else {
                    valueElement.textContent = \`Ответ \${index + 1}\`;
                }
            });
        }
        
        document.getElementById('configTitle').addEventListener('input', updatePreview);
        document.getElementById('configFooter').addEventListener('input', updatePreview);
        document.getElementById('configColor').addEventListener('input', function() {
            document.getElementById('configColorText').textContent = this.value;
            updatePreview();
        });
        
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
        
        function copyWebhookUrl() {
            const urlElement = document.getElementById('webhookUrlText');
            navigator.clipboard.writeText(urlElement.textContent);
            showAlert('URL скопирован в буфер обмена!', 'success');
        }
        
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
        
        function showMaintenanceModal() {
            document.getElementById('maintenanceModal').style.display = 'flex';
            document.getElementById('maintenanceResults').style.display = 'none';
        }

        function hideMaintenanceModal() {
            document.getElementById('maintenanceModal').style.display = 'none';
        }

        async function sendMaintenanceMessage() {
            const message = document.getElementById('maintenanceMessage').value;
            const resultsDiv = document.getElementById('maintenanceResultsContent');
            const resultsContainer = document.getElementById('maintenanceResults');
            
            resultsDiv.innerHTML = '🔄 Отправка сообщений...';
            resultsContainer.style.display = 'block';

            try {
                const response = await fetch('/admin/broadcast-maintenance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message }),
                    credentials: 'include'
                });

                if (response.status === 401) {
                    window.location.href = '/admin/login';
                    return;
                }

                const result = await response.json();
                
                if (result.status === 'success') {
                    let resultsHTML = '';
                    result.results.forEach((formResult, index) => {
                        const statusIcon = formResult.success ? '✅' : '❌';
                        resultsHTML += \`\${statusIcon} \${formResult.formName}: \${formResult.message}<br>\`;
                    });
                    
                    resultsDiv.innerHTML = resultsHTML;
                    showAlert(\`Сообщение отправлено на \${result.successCount} из \${result.totalCount} вебхуков\`, 'success');
                } else {
                    resultsDiv.innerHTML = \`❌ Ошибка: \${result.message}\`;
                    showAlert(result.message, 'error');
                }
            } catch (error) {
                resultsDiv.innerHTML = '❌ Ошибка соединения';
                showAlert('Ошибка при отправке сообщений', 'error');
            }
        }
        
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
        
        document.addEventListener('DOMContentLoaded', function() {
            document.getElementById('webhookUrlText').textContent = window.location.origin + '/webhook/yandex-form';
            loadForms();
        });
    </script>
</body>
</html>
`;

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
        `SELECT title, description, color, footer, mentions, question_titles, discord_id_fields, conditional_mentions
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

            let question_titles = [];
            let discord_id_fields = [0];
            let conditional_mentions = [];

            try {
                question_titles = JSON.parse(row.question_titles || '[]');
                discord_id_fields = JSON.parse(row.discord_id_fields || '[0]');
                conditional_mentions = JSON.parse(row.conditional_mentions || '[]');
            } catch (e) {
                console.error('Ошибка парсинга JSON полей:', e);
            }

            res.json({
                status: 'success',
                config: {
                    title: row.title || '',
                    description: row.description || '',
                    color: row.color || '#5865f2',
                    footer: row.footer || 'GTA5RP LAMESA',
                    mentions: row.mentions || '',
                    question_titles: question_titles,
                    discord_id_fields: discord_id_fields,
                    conditional_mentions: conditional_mentions
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
            title = ?, description = ?, color = ?, footer = ?, mentions = ?, 
            question_titles = ?, discord_id_fields = ?, conditional_mentions = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE form_id = ?`,
        [
            config.title, 
            config.description, 
            config.color, 
            config.footer, 
            config.mentions, 
            JSON.stringify(config.question_titles || []), 
            JSON.stringify(config.discord_id_fields || [0]),
            JSON.stringify(config.conditional_mentions || []),
            formId
        ],
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
        `SELECT form_name, webhook_url, title, description, color, footer, mentions, question_titles, discord_id_fields, conditional_mentions
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

            const testData = {
                form: { id: formId, title: formConfig.form_name },
                answers: [
                    { question_id: 'q1', text: '123456789012345678' },
                    { question_id: 'q2', text: '987654321098765432' },
                    { question_id: 'q3', text: 'Тестовый пользователь' },
                    { question_id: 'q4', text: '25 лет' },
                    { question_id: 'q5', text: 'Это тестовый пользователь для проверки системы' }
                ]
            };

            sendDiscordMessage(formConfig, testData.form, testData.answers)
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

// Новый маршрут для массовой рассылки сообщений о техработах
app.post('/admin/broadcast-maintenance', requireAuth, async (req, res) => {
    try {
        const { message } = req.body;
        
        if (!message || message.trim().length === 0) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'Сообщение не может быть пустым' 
            });
        }

        // Получаем все зарегистрированные формы
        const forms = await new Promise((resolve, reject) => {
            db.all('SELECT form_id, form_name, webhook_url FROM forms', (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });

        if (forms.length === 0) {
            return res.json({
                status: 'success',
                message: 'Нет зарегистрированных форм для отправки',
                results: [],
                successCount: 0,
                totalCount: 0
            });
        }

        const results = [];
        let successCount = 0;

        // Отправляем сообщение на каждый вебхук
        for (const form of forms) {
            try {
                const embed = {
                    title: "⚠️ Технические работы",
                    description: message,
                    color: 16776960, // желтый цвет
                    timestamp: new Date().toISOString(),
                    footer: { text: "GTA5RP LAMESA - Системное уведомление" }
                };

                const payload = {
                    embeds: [embed]
                };

                await axios.post(form.webhook_url, payload);
                
                results.push({
                    formId: form.form_id,
                    formName: form.form_name,
                    success: true,
                    message: 'Успешно отправлено'
                });
                successCount++;

                // Логируем успешную отправку
                await logRequest(form.form_id, 'MAINTENANCE_SENT', 'Уведомление о техработах отправлено');

                // Небольшая задержка чтобы не спамить Discord
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                console.error(`❌ Ошибка отправки для формы ${form.form_name}:`, error.message);
                
                results.push({
                    formId: form.form_id,
                    formName: form.form_name,
                    success: false,
                    message: `Ошибка: ${error.response?.data?.message || error.message}`
                });

                // Логируем ошибку
                await logRequest(form.form_id, 'MAINTENANCE_ERROR', error.message);
            }
        }

        // Логируем общий результат
        await logRequest('SYSTEM', 'MAINTENANCE_BROADCAST', 
            `Отправлено ${successCount}/${forms.length} уведомлений о техработах`);

        res.json({
            status: 'success',
            message: `Рассылка завершена. Успешно: ${successCount}/${forms.length}`,
            results: results,
            successCount: successCount,
            totalCount: forms.length
        });

    } catch (error) {
        console.error('❌ Ошибка массовой рассылки:', error);
        await logRequest('SYSTEM', 'MAINTENANCE_ERROR', error.message);
        res.status(500).json({ 
            status: 'error', 
            message: 'Внутренняя ошибка сервера при рассылке' 
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        version: '5.0-ADVANCED',
        note: 'Расширенные настройки: несколько Discord ID + условные упоминания',
        max_questions: MAX_QUESTIONS
    });
});

// Инициализация при запуске
initializeDatabase().then(database => {
    db = database;
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`
✨ 🚀 СЕРВЕР ЯНДЕКС ФОРМЫ → DISCORD ЗАПУЩЕН! ✨

📍 Порт: ${PORT}
📊 Админка: http://localhost:${PORT}/admin
🌐 Доступ извне: http://ваш_сервер:${PORT}/admin
🔐 Логин: admin / admin123

🎉 РАСШИРЕННЫЕ ВОЗМОЖНОСТИ ВЕРСИИ 5.0-ADVANCED:
✅ НЕСКОЛЬКО DISCORD ID - можно указать несколько полей для упоминания
✅ УСЛОВНЫЕ УПОМИНАНИЯ - тегить разные роли в зависимости от ответов
✅ ГИБКИЕ НАСТРОЙКИ - индивидуальное поведение для каждой формы
✅ КАСТОМНЫЕ НАЗВАНИЯ ВОПРОСОВ
✅ НЕ ТРЕБУЕТСЯ ПЕРЕДАЧА ВОПРОСОВ ИЗ ФОРМЫ
✅ ОГРАНИЧЕНИЕ: ${MAX_QUESTIONS} ВОПРОСОВ
✅ ФУТЕР "GTA5RP LAMESA"
✅ ПОДДЕРЖКА JSON-RPC POST
✅ УМНЫЕ УПОМИНАНИЯ
✅ СОХРАНЕНИЕ НАСТРОЕК ФОРМ
✅ РАССЫЛКА ТЕХНИЧЕСКИХ УВЕДОМЛЕНИЙ
🔐 БЕЗОПАСНАЯ АУТЕНТИФИКАЦИЯ

⚡ СЕРВЕР ГОТОВ К РАБОТЕ!

💡 ВАЖНО: Смените пароль администратора в коде!
        `);
    });
}).catch(err => {
    console.error('❌ Ошибка инициализации базы данных:', err);
    process.exit(1);
});

process.on('SIGINT', async () => {
    console.log('\n📴 Завершение работы сервера...');
    await logRequest('SYSTEM', 'SHUTDOWN', 'Сервер остановлен');
    if (db) {
        db.close();
    }
    process.exit(0);
});