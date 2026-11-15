CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, section TEXT NOT NULL, room TEXT NOT NULL DEFAULT '',
  UNIQUE(name, section)
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY, admission_no TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  class_id INTEGER NOT NULL REFERENCES classes(id), guardian_name TEXT NOT NULL,
  email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive'))
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','teacher','student')),
  student_id INTEGER REFERENCES students(id), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  CHECK((role='student' AND student_id IS NOT NULL) OR role!='student')
);
CREATE TABLE IF NOT EXISTS teacher_classes (
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY(teacher_id,class_id)
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id),
  teacher_id INTEGER NOT NULL REFERENCES users(id), attendance_date TEXT NOT NULL,
  session TEXT NOT NULL DEFAULT 'Full day', status TEXT NOT NULL CHECK(status IN ('Present','Absent','Late')),
  UNIQUE(student_id,attendance_date,session)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, class_id INTEGER NOT NULL REFERENCES classes(id),
  subject TEXT NOT NULL, max_marks REAL NOT NULL CHECK(max_marks > 0),
  pass_marks REAL NOT NULL CHECK(pass_marks >= 0 AND pass_marks <= max_marks), exam_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY, exam_id INTEGER NOT NULL REFERENCES exams(id), student_id INTEGER NOT NULL REFERENCES students(id),
  marks REAL NOT NULL CHECK(marks >= 0), grade TEXT NOT NULL, UNIQUE(exam_id,student_id)
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id), description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','Paid'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reference TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id INTEGER, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
