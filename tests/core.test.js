const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let child, base, tempDir;
const cookies = {};

async function request(route, options={}) {
  const headers={...(options.headers||{})};
  if(options.role&&cookies[options.role])headers.Cookie=cookies[options.role];
  if(options.body){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body)}
  const response=await fetch(`${base}${route}`,{...options,headers});
  const data=await response.json();
  return {response,data};
}
async function login(role,email){
  const {response,data}=await request('/api/auth/login',{method:'POST',body:{email,password:'school123'}});
  assert.equal(response.status,200);cookies[role]=response.headers.get('set-cookie').split(';')[0];return data.user;
}

before(async()=>{
  tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'schooldesk-test-'));
  const port=34000+(process.pid%15000);base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server/index.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DB_HOST:'',PORT:String(port),SMS_DB:path.join(tempDir,'test.db'),SESSION_SECRET:'test-secret'},stdio:'ignore'});
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    try{const res=await fetch(`${base}/api/health`);if(res.ok)return}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Test server did not start.');
});

after(()=>{if(child)child.kill();if(tempDir)fs.rmSync(tempDir,{recursive:true,force:true})});

test('assigned teacher can record attendance and duplicate is rejected',async()=>{
  await login('teacher','teacher@school.test');
  const {data:list}=await request('/api/students',{role:'teacher'});
  assert.equal(list.students.length,4);
  const student=list.students.find(s=>s.admission_no==='ST-2401');
  const notAssigned=(await request('/api/attendance',{role:'teacher',method:'POST',body:{student_id:5,date:'2026-11-16',session:'Full day',status:'Present'}}));
  assert.equal(notAssigned.response.status,403);
  const payload={student_id:student.id,date:'2026-11-16',session:'Full day',status:'Present'};
  const saved=await request('/api/attendance',{role:'teacher',method:'POST',body:payload});
  assert.equal(saved.response.status,201);
  const duplicate=await request('/api/attendance',{role:'teacher',method:'POST',body:payload});
  assert.equal(duplicate.response.status,409);
});

test('student can check in as present only for their own record and today',async()=>{
  await login('student','student@school.test');
  const saved=await request('/api/attendance',{role:'student',method:'POST',body:{student_id:2,date:'2000-01-01',session:'Morning',status:'Absent'}});
  assert.equal(saved.response.status,201);
  const {data}=await request('/api/attendance',{role:'student'});
  const todayRecords=data.records.filter(record=>record.attendance_date===new Date().toISOString().slice(0,10));
  assert.equal(todayRecords.length,1);
  assert.equal(todayRecords[0].student_id,1);
  assert.equal(todayRecords[0].status,'Present');
  assert.equal(todayRecords[0].session,'Full day');
  const duplicate=await request('/api/attendance',{role:'student',method:'POST',body:{}});
  assert.equal(duplicate.response.status,409);
});

test('result grades are computed from configured exam marks',async()=>{
  await login('teacher','teacher@school.test');
  const {data}=await request('/api/exams',{role:'teacher'});const exam=data.exams[0];
  const top=await request('/api/results',{role:'teacher',method:'POST',body:{exam_id:exam.id,student_id:1,marks:95}});
  assert.equal(top.response.status,200);assert.equal(top.data.grade,'A');
  const fail=await request('/api/results',{role:'teacher',method:'POST',body:{exam_id:exam.id,student_id:3,marks:30}});
  assert.equal(fail.data.grade,'Needs support');
  const over=await request('/api/results',{role:'teacher',method:'POST',body:{exam_id:exam.id,student_id:1,marks:101}});
  assert.equal(over.response.status,400);
});

test('administrator can add a student and duplicate admission numbers are rejected',async()=>{
  await login('admin','admin@school.test');
  const {data:classData}=await request('/api/classes',{role:'admin'});
  const classId=classData.classes[0].id;
  const payload={name:'Mira Shah',admission_no:'ST-2501',class_id:classId,guardian_name:'Rohan Shah',email:'rohan@example.test'};
  const created=await request('/api/students',{role:'admin',method:'POST',body:payload});
  assert.equal(created.response.status,201);
  const duplicate=await request('/api/students',{role:'admin',method:'POST',body:payload});
  assert.equal(duplicate.response.status,409);
});

test('student is restricted to their own records and fee ledger reconciles',async()=>{
  await login('student','student@school.test');
  const students=await request('/api/students',{role:'student'});
  assert.equal(students.data.students.length,1);assert.equal(students.data.students[0].admission_no,'ST-2401');
  const attempted=await request('/api/report-card?student_id=2',{role:'student'});
  assert.equal(attempted.data.student.admission_no,'ST-2401');
  const fee=await request('/api/fees',{role:'student'});
  assert.equal(fee.data.invoices.length,1);assert.equal(fee.data.invoices[0].due_cents,75000);
  await login('admin','admin@school.test');
  const paid=await request(`/api/fees/${fee.data.invoices[0].id}/payments`,{role:'admin',method:'POST',body:{amount:750}});
  assert.equal(paid.response.status,201);assert.equal(paid.data.due_cents,0);
  const refreshed=await request('/api/fees',{role:'student'});
  assert.equal(refreshed.data.invoices[0].paid_cents+refreshed.data.invoices[0].due_cents,refreshed.data.invoices[0].amount_cents);
});
