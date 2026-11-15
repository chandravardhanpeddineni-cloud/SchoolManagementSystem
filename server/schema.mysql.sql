CREATE TABLE IF NOT EXISTS classes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  section VARCHAR(40) NOT NULL,
  room VARCHAR(100) NOT NULL DEFAULT '',
  UNIQUE KEY uq_classes_name_section (name, section)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS students (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admission_no VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  class_id INT UNSIGNED NOT NULL,
  guardian_name VARCHAR(180) NOT NULL,
  email VARCHAR(254) NOT NULL,
  status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  CONSTRAINT fk_students_class FOREIGN KEY(class_id) REFERENCES classes(id),
  KEY idx_students_class (class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('admin','teacher','student') NOT NULL,
  student_id INT UNSIGNED NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_users_student FOREIGN KEY(student_id) REFERENCES students(id),
  CONSTRAINT chk_student_link CHECK(role <> 'student' OR student_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS teacher_classes (
  recorded_by INT UNSIGNED NOT NULL,
  class_id INT UNSIGNED NOT NULL,
  PRIMARY KEY(teacher_id,class_id),
  CONSTRAINT fk_teacher_classes_user FOREIGN KEY(teacher_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_teacher_classes_class FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id INT UNSIGNED NOT NULL,
  teacher_id INT UNSIGNED NOT NULL,
  attendance_date DATE NOT NULL,
  session VARCHAR(40) NOT NULL DEFAULT 'Full day',
  status ENUM('Present','Absent','Late') NOT NULL,
  UNIQUE KEY uq_attendance_student_date_session (student_id,attendance_date,session),
  KEY idx_attendance_date (attendance_date),
  CONSTRAINT fk_attendance_student FOREIGN KEY(student_id) REFERENCES students(id),
  CONSTRAINT fk_attendance_recorder FOREIGN KEY(recorded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS exams (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(180) NOT NULL,
  class_id INT UNSIGNED NOT NULL,
  subject VARCHAR(120) NOT NULL,
  max_marks DECIMAL(8,2) NOT NULL,
  pass_marks DECIMAL(8,2) NOT NULL,
  exam_date DATE NOT NULL,
  CONSTRAINT chk_exam_max_marks CHECK(max_marks > 0),
  CONSTRAINT chk_exam_pass_marks CHECK(pass_marks >= 0 AND pass_marks <= max_marks),
  CONSTRAINT fk_exams_class FOREIGN KEY(class_id) REFERENCES classes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS results (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  exam_id INT UNSIGNED NOT NULL,
  student_id INT UNSIGNED NOT NULL,
  marks DECIMAL(8,2) NOT NULL,
  grade VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_results_exam_student (exam_id,student_id),
  CONSTRAINT chk_result_marks CHECK(marks >= 0),
  CONSTRAINT fk_results_exam FOREIGN KEY(exam_id) REFERENCES exams(id),
  CONSTRAINT fk_results_student FOREIGN KEY(student_id) REFERENCES students(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoices (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id INT UNSIGNED NOT NULL,
  description VARCHAR(180) NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  due_date DATE NOT NULL,
  status ENUM('Open','Paid') NOT NULL DEFAULT 'Open',
  CONSTRAINT chk_invoice_amount CHECK(amount_cents > 0),
  CONSTRAINT fk_invoices_student FOREIGN KEY(student_id) REFERENCES students(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT UNSIGNED NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  paid_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reference VARCHAR(80) NOT NULL UNIQUE,
  created_by INT UNSIGNED NOT NULL,
  CONSTRAINT chk_payment_amount CHECK(amount_cents > 0),
  CONSTRAINT fk_payments_invoice FOREIGN KEY(invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_payments_user FOREIGN KEY(created_by) REFERENCES users(id),
  KEY idx_payments_invoice (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  action VARCHAR(80) NOT NULL,
  entity VARCHAR(80) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  details JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY(user_id) REFERENCES users(id),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
