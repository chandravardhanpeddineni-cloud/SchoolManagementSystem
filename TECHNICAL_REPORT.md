# SchoolDesk Technical Report

## Purpose

SchoolDesk is a local-first school management MVP built to demonstrate the primary administrator, teacher, and student journeys. The frontend uses React and Vite. A Node.js/Express modular monolith owns authentication, authorization, validation, business rules, audit events, and MySQL persistence through the mysql2 promise pool.

## Design decisions

The application uses a same-origin JSON API and server-side session cookie. This keeps the React client focused on presentation and ensures permissions are checked on every protected request. Teachers receive a class scope through `teacher_classes`; student accounts are attached to one student for this demo. Student endpoints derive the permitted record from the authenticated account rather than trusting a requested student identifier.

MySQL is configured through `.env` (`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and `DB_PORT`). The schema is maintained in `server/schema.mysql.sql`, has foreign keys and unique constraints, and is initialized on server startup. Synthetic demo records are seeded only for an empty database. Material actions write to `audit_log`. A SQLite fallback remains for integration tests when `DB_HOST` is unset.

Attendance uniqueness is enforced by `(student_id, attendance_date, session)`. Results validate the exam class, teacher scope, and marks range before calculating a grade. Fee balances are calculated from invoice and payment rows; payment insertion and invoice status changes use a transaction and reject overpayments.

## Security and privacy

Passwords use bcrypt hashes. The application uses an HTTP-only, same-site session cookie, rejects repeated login attempts temporarily, and checks account state and role on the server. Student report cards, fees, profile, exams, and attendance are limited to the linked student. No real student or payment information is included.

## Verification

`npm run build` completes successfully. The Node integration suite uses the SQLite test fallback and covers four scenarios: teacher class scope and duplicate attendance conflict; result grade and marks validation; administrator student creation and admission-number conflict; and student privacy with fee-ledger reconciliation. The live MySQL API health check and migrated student sign-in were verified.

## Current limits

The demo uses Express's in-memory session store, fixed demo grade bands, and one student per student account. Class/teacher/subject administration, student account provisioning, recurring invoice generation, and hosting are outside this MVP. Payments are simulated and do not contact a payment provider.
