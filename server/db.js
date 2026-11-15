require('./env');
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
const useMysql = Boolean(process.env.DB_HOST);

function gradeFor(marks, maximum, passMarks) {
  if (marks < passMarks) return 'Needs support';
  const ratio = marks / maximum;
  return ratio >= .9 ? 'A' : ratio >= .8 ? 'B' : ratio >= .7 ? 'C' : ratio >= .6 ? 'D' : 'E';
}

let sqlite, pool;
let mysql, mysqlConfig, mysqlDatabase;
if (useMysql) {
  mysql = require('mysql2/promise');
  const database = process.env.DB_NAME || 'my_backend';
  if (!/^[A-Za-z0-9_$]+$/.test(database)) throw new Error('DB_NAME must contain only letters, numbers, underscores, or dollar signs.');
  mysqlDatabase = database;
  mysqlConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    port: Number(process.env.DB_PORT || 3306),
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    queueLimit: 0,
    dateStrings: true,
    decimalNumbers: true,
  };
  pool = mysql.createPool({ ...mysqlConfig, database });
} else {
  const Database = require('better-sqlite3');
  const dbPath = process.env.SMS_DB || path.join(__dirname, '..', 'data', 'school.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}
function mysqlSql(sql) {
  return sql.replace(/c\.name\s*\|\|\s*' - '\s*\|\|\s*c\.section/g, "CONCAT(c.name, ' - ', c.section)");
}

async function query(sql, params = []) {
  if (!useMysql) return sqlite.prepare(sql).all(...params);
  const connection = storage.getStore() || pool;
  const [rows] = await connection.execute(mysqlSql(sql), params);
  return rows;
}
async function get(sql, ...params) {
  if (!useMysql) return sqlite.prepare(sql).get(...params);
  const connection = storage.getStore() || pool;
  const [rows] = await connection.execute(mysqlSql(sql), params);
  return rows[0];
}
async function all(sql, ...params) {
  if (!useMysql) return sqlite.prepare(sql).all(...params);
  const connection = storage.getStore() || pool;
  const [rows] = await connection.execute(mysqlSql(sql), params);
  return rows;
}
async function run(sql, ...params) {
  if (!useMysql) {
    const result = sqlite.prepare(sql).run(...params);
    return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.changes };
  }
  const connection = storage.getStore() || pool;
  const [result] = await connection.execute(mysqlSql(sql), params);
  return { lastInsertRowid: Number(result.insertId || 0), changes: result.affectedRows };
}
async function transaction(action) {
  if (!useMysql) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = await action(); sqlite.exec('COMMIT'); return result; }
    catch (err) { sqlite.exec('ROLLBACK'); throw err; }
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await storage.run(connection, action);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function initializeMysql() {
  try {
    const probe = await mysql.createConnection({ ...mysqlConfig, database: mysqlDatabase });
    await probe.end();
  } catch (err) {
    if (err.code !== 'ER_BAD_DB_ERROR') throw err;
    const bootstrap = await mysql.createConnection(mysqlConfig);
    try { await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${mysqlDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
    finally { await bootstrap.end(); }
  }
  const connection = await pool.getConnection();
  try {
    await connection.ping();
    const statements = fs.readFileSync(path.join(__dirname, 'schema.mysql.sql'), 'utf8').split(';').map(s => s.trim()).filter(Boolean);
    for (const statement of statements) await connection.query(statement);
    const [roleColumns] = await connection.query("SHOW COLUMNS FROM users LIKE 'role'");
    if (roleColumns[0]?.Type?.includes('guardian')) {
      await connection.query("ALTER TABLE users MODIFY role ENUM('admin','teacher','guardian','student') NOT NULL");
      await connection.query(`UPDATE users u JOIN students s ON s.id=u.student_id
        SET u.name=s.name,
            u.email=CASE u.email
              WHEN 'guardian@school.test' THEN 'student@school.test'
              WHEN 'guardian2@school.test' THEN 'student2@school.test'
              ELSE u.email
            END
        WHERE u.role='guardian'`);
      await connection.query("UPDATE users SET role='student' WHERE role='guardian'");
      await connection.query("ALTER TABLE users MODIFY role ENUM('admin','teacher','student') NOT NULL");
    }
    const [checks] = await connection.query("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='users' AND CONSTRAINT_TYPE='CHECK'");
    const checkNames = new Set(checks.map(row => row.CONSTRAINT_NAME));
    if (checkNames.has('chk_guardian_student')) await connection.query('ALTER TABLE users DROP CHECK chk_guardian_student');
    if (!checkNames.has('chk_student_link')) await connection.query("ALTER TABLE users ADD CONSTRAINT chk_student_link CHECK(role <> 'student' OR student_id IS NOT NULL)");
    const [oldAttendanceColumn] = await connection.query("SHOW COLUMNS FROM attendance LIKE 'teacher_id'");
    if (oldAttendanceColumn.length) {
      await connection.query('ALTER TABLE attendance DROP FOREIGN KEY fk_attendance_teacher');
      await connection.query('ALTER TABLE attendance CHANGE COLUMN teacher_id recorded_by INT UNSIGNED NOT NULL');
      await connection.query('ALTER TABLE attendance ADD CONSTRAINT fk_attendance_recorder FOREIGN KEY(recorded_by) REFERENCES users(id)');
    }
  } finally { connection.release(); }
  await seed();
}

async function seed() {
  if ((await get('SELECT COUNT(*) AS count FROM users')).count) return;
  await transaction(async () => {
    const insertClass = async (name, section, room) => (await run('INSERT INTO classes(name,section,room) VALUES(?,?,?)', name, section, room)).lastInsertRowid;
    const classIds = {
      '8A': await insertClass('Grade 8', 'A', 'Room 204'),
      '8B': await insertClass('Grade 8', 'B', 'Room 205'),
      '7A': await insertClass('Grade 7', 'A', 'Room 103'),
    };
    const insertStudent = async (s) => (await run('INSERT INTO students(admission_no,name,class_id,guardian_name,email,status) VALUES(?,?,?,?,?,?)', ...s)).lastInsertRowid;
    const studentRows = [
      ['ST-2401', 'Aarav Sharma', classIds['8A'], 'Meera Sharma', 'meera@example.test', 'Active'],
      ['ST-2402', 'Ananya Iyer', classIds['8A'], 'Ravi Iyer', 'ravi@example.test', 'Active'],
      ['ST-2403', 'Kabir Patel', classIds['8A'], 'Nisha Patel', 'nisha@example.test', 'Active'],
      ['ST-2404', 'Diya Nair', classIds['8B'], 'Arun Nair', 'arun@example.test', 'Active'],
      ['ST-2405', 'Ishaan Rao', classIds['7A'], 'Kavya Rao', 'kavya@example.test', 'Active'],
    ];
    const studentIds = {};
    for (const s of studentRows) studentIds[s[0]] = await insertStudent(s);
    const password = process.env.SMS_DEMO_PASSWORD || 'school123';
    const addUser = async (name,email,role,studentId=null) => (await run('INSERT INTO users(name,email,password_hash,role,student_id) VALUES(?,?,?,?,?)',name,email,bcrypt.hashSync(password,10),role,studentId)).lastInsertRowid;
    const adminId = await addUser('School Admin','admin@school.test','admin');
    const teacherId = await addUser('Priya Menon','teacher@school.test','teacher');
    await addUser('Aarav Sharma','student@school.test','student',studentIds['ST-2401']);
    await addUser('Ananya Iyer','student2@school.test','student',studentIds['ST-2402']);
    await run('INSERT INTO teacher_classes(teacher_id,class_id) VALUES(?,?)',teacherId,classIds['8A']);
    await run('INSERT INTO teacher_classes(teacher_id,class_id) VALUES(?,?)',teacherId,classIds['8B']);
    const today = new Date().toISOString().slice(0,10);
    const examId = (await run('INSERT INTO exams(title,class_id,subject,max_marks,pass_marks,exam_date) VALUES(?,?,?,?,?,?)','Unit 2 Assessment',classIds['8A'],'Mathematics',100,35,today)).lastInsertRowid;
    for (const [admission,marks] of [['ST-2401',88],['ST-2402',76],['ST-2403',31]]) await run('INSERT INTO results(exam_id,student_id,marks,grade) VALUES(?,?,?,?)',examId,studentIds[admission],marks,gradeFor(marks,100,35));
    for (const admission of ['ST-2401','ST-2402','ST-2403','ST-2404']) await run('INSERT INTO invoices(student_id,description,amount_cents,due_date) VALUES(?,?,?,?)',studentIds[admission],'Term 1 tuition',125000,'2026-11-30');
    const invoice = await get('SELECT id FROM invoices WHERE student_id=?',studentIds['ST-2401']);
    await run('INSERT INTO payments(invoice_id,amount_cents,reference,created_by) VALUES(?,?,?,?)',invoice.id,50000,'DEMO-PAY-001',adminId);
  });
}

let ready;
if (useMysql) ready = initializeMysql();
else {
  ready = seed();
}

module.exports = { all, get, query, run, transaction, gradeFor, ready, isMysql: useMysql };
