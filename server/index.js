require('./env');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, transaction, gradeFor, ready, isMysql } = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(session({
  name: 'schooldesk.sid',
  secret: process.env.SESSION_SECRET || 'local-development-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 12 * 60 * 60 * 1000 },
}));

const loginAttempts = new Map();
const money = cents => Number((Number(cents) / 100).toFixed(2));
const userView = user => ({ id: user.id, name: user.name, email: user.email, role: user.role });
const error = (res, status, message) => res.status(status).json({ error: message });
const route = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

async function auditAction(user, action, entity, id, details = {}) {
  await run('INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)',
    user.id, action, entity, id || null, JSON.stringify(details));
}
async function scopeClasses(user) {
  if (user.role === 'admin') return null;
  if (user.role === 'teacher') return (await all('SELECT class_id FROM teacher_classes WHERE teacher_id=?', user.id)).map(row => Number(row.class_id));
  const student = await get('SELECT class_id FROM students WHERE id=?', user.student_id);
  return student ? [Number(student.class_id)] : [];
}
async function studentsFor(user) {
  if (user.role === 'student') return all("SELECT s.*,c.name||' - '||c.section AS class_name FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=?", user.student_id);
  const scope = await scopeClasses(user);
  if (scope === null) return all("SELECT s.*,c.name||' - '||c.section AS class_name FROM students s JOIN classes c ON c.id=s.class_id ORDER BY s.name");
  if (!scope.length) return [];
  return all(`SELECT s.*,c.name||' - '||c.section AS class_name FROM students s JOIN classes c ON c.id=s.class_id WHERE s.class_id IN (${scope.map(()=>'?').join(',')}) ORDER BY s.name`, ...scope);
}
function auth(req, res, next) {
  const user = req.session.user;
  if (!user) return error(res, 401, 'Sign in to continue.');
  return route(async (request, response) => {
    const current = await get('SELECT id,name,email,role,student_id,active FROM users WHERE id=?', user.id);
    if (!current || !current.active) { request.session.destroy(() => {}); return error(response, 401, 'Your session has expired. Sign in again.'); }
    request.user = current;
    next();
  })(req, res, next);
}
const roles = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : error(res, 403, 'Your account cannot perform this action.');

app.get('/api/health', (req, res) => res.json({ ok: true, database: isMysql ? 'mysql' : 'sqlite' }));
app.post('/api/auth/login', route(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const now = Date.now();
  const attempt = loginAttempts.get(email);
  if (attempt && attempt.count >= 8 && now - attempt.started < 10 * 60 * 1000) return error(res, 429, 'Too many sign-in attempts. Try again in ten minutes.');
  const user = await get('SELECT * FROM users WHERE email=? AND active=1', email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    loginAttempts.set(email, { count: attempt && now - attempt.started < 10 * 60 * 1000 ? attempt.count + 1 : 1, started: attempt && now - attempt.started < 10 * 60 * 1000 ? attempt.started : now });
    return error(res, 401, 'Email or password is incorrect.');
  }
  loginAttempts.delete(email);
  req.session.regenerate(err => {
    if (err) return error(res, 500, 'Could not start a session.');
    req.session.user = { id: user.id };
    res.json({ user: userView(user) });
  });
}));
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => {
  res.clearCookie('schooldesk.sid', { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
}));
app.get('/api/auth/me', auth, route(async (req, res) => res.json({ user: userView(req.user) })));

app.get('/api/dashboard', auth, route(async (req, res) => {
  const students = await studentsFor(req.user);
  const ids = students.map(student => student.id);
  const marks = ids.map(() => '?').join(',');
  const attendance = ids.length
    ? await get(`SELECT COUNT(*) total,SUM(CASE WHEN status='Present' THEN 1 ELSE 0 END) present FROM attendance WHERE student_id IN (${marks})`, ...ids)
    : { total: 0, present: 0 };
  const fees = await feeRows(req.user);
  const outstanding = fees.reduce((sum, invoice) => sum + Number(invoice.due_cents), 0);
  const recent = ids.length ? await all(`SELECT a.*,s.name student_name,c.name||' - '||c.section class_name FROM attendance a JOIN students s ON s.id=a.student_id JOIN classes c ON c.id=s.class_id WHERE a.student_id IN (${marks}) ORDER BY a.attendance_date DESC,a.id DESC LIMIT 5`, ...ids) : [];
  const activity = req.user.role === 'admin' ? await all('SELECT l.action,l.entity,l.entity_id,l.created_at,u.name actor FROM audit_log l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 5') : [];
  res.json({ role: req.user.role, student_count: students.length, attendance_rate: Number(attendance.total) ? Math.round(100 * Number(attendance.present || 0) / Number(attendance.total)) : 0, open_invoices: fees.filter(f => Number(f.due_cents) > 0).length, outstanding_cents: outstanding, students: students.slice(0, 5), recent_attendance: recent, activity });
}));

app.get('/api/students', auth, route(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const allStudents = await studentsFor(req.user);
  const filtered = q ? allStudents.filter(s => [s.name, s.admission_no, s.class_name].some(v => v.toLowerCase().includes(q))) : allStudents;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  res.json({ students: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page, limit });
}));
app.get('/api/classes', auth, roles('admin'), route(async (req, res) => res.json({ classes: await all('SELECT id,name,section,room FROM classes ORDER BY name,section') })));
app.post('/api/students', auth, roles('admin'), route(async (req, res) => {
  const admissionNo = String(req.body?.admission_no || '').trim();
  const name = String(req.body?.name || '').trim();
  const guardianName = String(req.body?.guardian_name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const classId = Number(req.body?.class_id);
  if (!admissionNo || !name || !guardianName || !/^\S+@\S+\.\S+$/.test(email) || !Number.isInteger(classId)) return error(res, 400, 'Complete each student field with a valid guardian email and class.');
  if (!await get('SELECT id FROM classes WHERE id=?', classId)) return error(res, 400, 'Choose an existing class.');
  try {
    const id = await transaction(async () => {
      const result = await run('INSERT INTO students(admission_no,name,class_id,guardian_name,email,status) VALUES(?,?,?,?,?,?)', admissionNo, name, classId, guardianName, email, 'Active');
      await auditAction(req.user, 'created', 'student', result.lastInsertRowid, { admission_no: admissionNo, class_id: classId });
      return result.lastInsertRowid;
    });
    return res.status(201).json({ ok: true, id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || String(err.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) return error(res, 409, 'That admission number is already in use.');
    throw err;
  }
}));

app.get('/api/attendance', auth, route(async (req, res) => {
  const ids = (await studentsFor(req.user)).map(student => student.id);
  if (!ids.length) return res.json({ records: [] });
  const records = await all(`SELECT a.*,s.name student_name,c.name||' - '||c.section class_name FROM attendance a JOIN students s ON s.id=a.student_id JOIN classes c ON c.id=s.class_id WHERE a.student_id IN (${ids.map(()=>'?').join(',')}) ORDER BY a.attendance_date DESC,a.id DESC LIMIT 100`, ...ids);
  res.json({ records });
}));
app.post('/api/attendance', auth, roles('admin', 'teacher', 'student'), route(async (req, res) => {
  const selfCheckIn = req.user.role === 'student';
  const studentId = selfCheckIn ? Number(req.user.student_id) : Number(req.body?.student_id);
  const date = selfCheckIn ? new Date().toISOString().slice(0, 10) : String(req.body?.date || '');
  const sessionName = selfCheckIn ? 'Full day' : String(req.body?.session || 'Full day');
  const status = selfCheckIn ? 'Present' : String(req.body?.status || '');
  if (!Number.isInteger(studentId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !['Present', 'Absent', 'Late'].includes(status) || !sessionName.trim()) return error(res, 400, 'Provide a student, valid date, session, and attendance status.');
  const student = await get('SELECT id,class_id FROM students WHERE id=?', studentId);
  if (!student) return error(res, 404, 'Student not found.');
  const scope = await scopeClasses(req.user);
  if (scope !== null && !scope.includes(Number(student.class_id))) return error(res, 403, 'You can only record attendance for your assigned classes.');
  try {
    const id = await transaction(async () => {
      const info = await run('INSERT INTO attendance(student_id,recorded_by,attendance_date,session,status) VALUES(?,?,?,?,?)', studentId, req.user.id, date, sessionName.trim(), status);
      await auditAction(req.user, selfCheckIn ? 'self-checked-in' : 'recorded', 'attendance', info.lastInsertRowid, { student_id: studentId, status, date, session: sessionName.trim() });
      return info.lastInsertRowid;
    });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || String(err.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) return error(res, 409, 'Attendance for this student, date, and session is already recorded.');
    throw err;
  }
}));

app.get('/api/exams', auth, route(async (req, res) => {
  const scope = await scopeClasses(req.user);
  if (scope !== null && !scope.length) return res.json({ exams: [] });
  const where = scope === null ? '' : ` WHERE e.class_id IN (${scope.map(() => '?').join(',')})`;
  const exams = await all(`SELECT e.*,c.name||' - '||c.section class_name FROM exams e JOIN classes c ON c.id=e.class_id${where} ORDER BY e.exam_date DESC`, ...(scope || []));
  const resultRows = await Promise.all(exams.map(async exam => {
    const studentFilter = req.user.role === 'student' ? ' AND r.student_id=?' : '';
    const params = req.user.role === 'student' ? [exam.id, req.user.student_id] : [exam.id];
    const results = await all(`SELECT r.student_id,s.name,r.marks,r.grade FROM results r JOIN students s ON s.id=r.student_id WHERE r.exam_id=?${studentFilter}`, ...params);
    return { ...exam, results };
  }));
  res.json({ exams: resultRows });
}));
app.post('/api/results', auth, roles('admin', 'teacher'), route(async (req, res) => {
  const examId = Number(req.body?.exam_id), studentId = Number(req.body?.student_id), marks = Number(req.body?.marks);
  if (!Number.isInteger(examId) || !Number.isInteger(studentId) || !Number.isFinite(marks)) return error(res, 400, 'Provide a valid exam, student, and mark.');
  const exam = await get('SELECT * FROM exams WHERE id=?', examId), student = await get('SELECT * FROM students WHERE id=?', studentId);
  if (!exam || !student) return error(res, 404, 'Exam or student not found.');
  if (Number(student.class_id) !== Number(exam.class_id)) return error(res, 400, 'Student is not enrolled in this exam class.');
  const scope = await scopeClasses(req.user);
  if (scope !== null && !scope.includes(Number(exam.class_id))) return error(res, 403, 'You can only enter results for assigned classes.');
  if (marks < 0 || marks > Number(exam.max_marks)) return error(res, 400, `Marks must be between 0 and ${exam.max_marks}.`);
  const grade = gradeFor(marks, Number(exam.max_marks), Number(exam.pass_marks));
  const sql = isMysql
    ? 'INSERT INTO results(exam_id,student_id,marks,grade) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE marks=VALUES(marks),grade=VALUES(grade)'
    : 'INSERT INTO results(exam_id,student_id,marks,grade) VALUES(?,?,?,?) ON CONFLICT(exam_id,student_id) DO UPDATE SET marks=excluded.marks,grade=excluded.grade';
  await run(sql, examId, studentId, marks, grade);
  const saved = await get('SELECT id FROM results WHERE exam_id=? AND student_id=?', examId, studentId);
  await auditAction(req.user, 'entered', 'result', saved?.id, { exam_id: examId, student_id: studentId, marks, grade });
  res.json({ ok: true, grade });
}));

async function feeRows(user) {
  let condition = '', params = [];
  const scope = await scopeClasses(user);
  if (user.role === 'student') { condition = 'WHERE i.student_id=?'; params = [user.student_id]; }
  else if (user.role === 'teacher') {
    if (!scope.length) return [];
    condition = `WHERE s.class_id IN (${scope.map(() => '?').join(',')})`;
    params = scope;
  }
  return (await all(`SELECT i.*,s.name student_name,s.admission_no,COALESCE(SUM(p.amount_cents),0) paid_cents FROM invoices i JOIN students s ON s.id=i.student_id LEFT JOIN payments p ON p.invoice_id=i.id ${condition} GROUP BY i.id ORDER BY i.due_date`, ...params))
    .map(invoice => ({ ...invoice, paid_cents: Number(invoice.paid_cents), due_cents: Number(invoice.amount_cents) - Number(invoice.paid_cents) }));
}
app.get('/api/fees', auth, route(async (req, res) => res.json({ invoices: await feeRows(req.user) })));
app.post('/api/fees/:id/payments', auth, roles('admin'), route(async (req, res) => {
  const invoiceId = Number(req.params.id), amount = Math.round(Number(req.body?.amount) * 100);
  if (!Number.isInteger(invoiceId) || !Number.isFinite(amount) || amount <= 0) return error(res, 400, 'Payment must be a positive amount.');
  try {
    const result = await transaction(async () => {
      const invoice = await get(`SELECT amount_cents FROM invoices WHERE id=?${isMysql ? ' FOR UPDATE' : ''}`, invoiceId);
      if (!invoice) throw Object.assign(new Error('Invoice not found.'), { status: 404 });
      const paymentTotal = await get('SELECT COALESCE(SUM(amount_cents),0) paid FROM payments WHERE invoice_id=?', invoiceId);
      const due = Number(invoice.amount_cents) - Number(paymentTotal.paid);
      if (amount > due) throw Object.assign(new Error('Payment exceeds the outstanding balance.'), { status: 409 });
      const reference = `SIM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      await run('INSERT INTO payments(invoice_id,amount_cents,reference,created_by) VALUES(?,?,?,?)', invoiceId, amount, reference, req.user.id);
      if (amount === due) await run("UPDATE invoices SET status='Paid' WHERE id=?", invoiceId);
      await auditAction(req.user, 'recorded', 'payment', invoiceId, { amount_cents: amount, reference });
      return { reference, paid_cents: Number(paymentTotal.paid) + amount, due_cents: due - amount };
    });
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return error(res, err.status, err.message);
    throw err;
  }
}));

app.get('/api/report-card', auth, route(async (req, res) => {
  let studentId = req.user.role === 'student' ? req.user.student_id : Number(req.query.student_id);
  if (req.user.role !== 'student' && !studentId) studentId = (await studentsFor(req.user))[0]?.id;
  const student = await get("SELECT s.id,s.name,s.admission_no,c.name||' - '||c.section class_name FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=?", studentId);
  if (!student) return error(res, 404, 'Student not found.');
  if (req.user.role !== 'student') {
    const scope = await scopeClasses(req.user);
    const actual = await get('SELECT class_id FROM students WHERE id=?', studentId);
    if (scope !== null && !scope.includes(Number(actual.class_id))) return error(res, 403, 'You can only view assigned classes.');
  }
  const results = await all('SELECT e.title,e.subject,e.max_marks,e.pass_marks,e.exam_date,r.marks,r.grade FROM results r JOIN exams e ON e.id=r.exam_id WHERE r.student_id=? ORDER BY e.exam_date DESC', studentId);
  res.json({ student, results });
}));

const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(distPath, 'index.html')));
}
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  ready.then(() => app.listen(port, () => console.log(`SchoolDesk server listening on http://localhost:${port}`)))
    .catch(err => { console.error(`Database connection failed: ${err.message}`); process.exitCode = 1; });
}
module.exports = { app };
