import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCpos, fetchFromHandler } from '../fake/server.js';
import { createCposClient } from '../client.js';

process.env.CPOS_KIT_MAINTAINER = '1'; // kit 自身のテストだけ raw を許す (npm test の環境変数書式は bash 専用なので、ここで立てる)

test('ソケット無しのKIT 模擬サーバを client に差し込める', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  assert.equal((await c.facilities.list()).length, 2);
  assert.equal((await c.masterUsers.list({ facilityId: 'fac_momiji' })).length, 10);
  const d = c.appData('demo');
  const r = await d.create('notes', { text: 'x' }, { scope: 'organization' });
  assert.equal((await d.get('notes', r.id, { scope: 'organization' })).data.text, 'x');
  await d.remove('notes', r.id, { scope: 'organization' });            // 204 を Response にできる
  assert.equal(fake.state.requests.length, 5);
});

test('capabilities は本物と同じ形で返る', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  const cap = await c.platform.capabilities();
  assert.equal(cap.server, 'cpos');
  assert.equal(cap.features.masterUsers.masterUserId, true);
});

test('ソケット無しでも 401 / 403 / 501 の hint は同じ', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, fetch: fake.fetch });
  await assert.rejects(c.facilities.list(), (e) => e.status === 401 && /Bearer/.test(e.hint));
  const c2 = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch, rawPolicy: 'allow' });
  await assert.rejects(c2.masterUsers.list({ facilityId: 'nope' }), (e) => e.status === 404);
  await assert.rejects(c2.raw('GET', '/api/nothing'), (e) => e.status === 501);
});

test('KIT 模擬サーバ: 看護師は facility-staff の profession で分かる。過去の利用は care-service-actuals にある', async () => {
  const f = createFakeCpos();
  const fx = fetchFromHandler(f.handle);
  const H = (fid) => ({ Authorization: 'Bearer cpos_app_dev', 'X-Cpos-Facility-Id': fid });
  const fac = await (await fx('http://fake/api/platform/facilities', { headers: { Authorization: 'Bearer cpos_app_dev' } })).json();
  const fid = fac[0].id;

  const staff = await (await fx(`http://fake/api/platform/facility-staff?facilityId=${fid}`, { headers: H(fid) })).json();
  assert.ok(Array.isArray(staff.items) && staff.items.length, '職員が返る');
  // ステージングで確認した項目名 (これが違うと本物に差し替えたとき画面が壊れる)
  for (const k of ['id', 'name', 'profession', 'professions', 'role', 'status', 'facilityId']) {
    assert.ok(k in staff.items[0], `項目 ${k} がある`);
  }
  assert.ok(staff.items.some((s) => s.profession === 'nurse'), '看護師が 1 人はいる (資格で絞る機能を試せる)');

  const act = await (await fx(`http://fake/api/care-service-actuals/v1?facilityId=${fid}`, { headers: H(fid) })).json();
  assert.ok(Array.isArray(act.items) && act.items.length, '過去の実績が返る');
  for (const k of ['insuredNumber', 'serviceDate', 'serviceType', 'assignedStaffName', 'status']) {
    assert.ok(k in act.items[0], `項目 ${k} がある`);
  }
  const ins = act.items[0].insuredNumber;
  const one = await (await fx(`http://fake/api/care-service-actuals/v1?facilityId=${fid}&insuredNumber=${ins}`, { headers: H(fid) })).json();
  assert.ok(one.items.every((r) => r.insuredNumber === ins), '被保険者番号で絞れる');
});

test('KIT 模擬サーバ: 形が未確認の API (届出配置など) は推測で返さず 501 で理由を言う', async () => {
  const f = createFakeCpos();
  const fx = fetchFromHandler(f.handle);
  const fac = await (await fx('http://fake/api/platform/facilities', { headers: { Authorization: 'Bearer cpos_app_dev' } })).json();
  const res = await fx(`http://fake/api/reported-placements/summary?facilityId=${fac[0].id}`, { headers: { Authorization: 'Bearer cpos_app_dev', 'X-Cpos-Facility-Id': fac[0].id } });
  assert.equal(res.status, 501);
  assert.match((await res.json()).hint, /実物を見てから/);
});

test('KIT 模擬サーバ: manifest で宣言していないスコープは本物と同じ 403 で落ちる', async () => {
  // 実害: 模擬サーバが全スコープで通すと、宣言漏れが本物ではじめて 403 になる (実験 8)
  const f = createFakeCpos({ scopes: ['facilities:read'] });   // manifest に facilities:read だけ宣言した想定
  const fx = fetchFromHandler(f.handle);
  const fac = await (await fx('http://fake/api/platform/facilities', { headers: { Authorization: 'Bearer cpos_app_dev' } })).json();
  const res = await fx(`http://fake/api/platform/facility-staff?facilityId=${fac[0].id}`, { headers: { Authorization: 'Bearer cpos_app_dev', 'X-Cpos-Facility-Id': fac[0].id } });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.requiredScope, 'facility-staff:read');
  assert.match(j.hint, /apiTokenScopes/);
});

test('KIT 模擬サーバ: シフト (計画 → 割当の置換 → 履歴) と人事系が本物の形で返る (実験 14 で両者が要求)', async () => {
  const f = createFakeCpos();
  const c = createCposClient({ baseUrl: f.baseUrl, token: 'cpos_app_x', fetch: f.fetch });
  const fid = (await c.facilities.list())[0].id;
  const types = await c.app.shifts.getShiftTypes({ facilityId: fid });
  assert.ok(Array.isArray(types) && types.length >= 5, '勤務区分は配列');
  for (const k of ['id', 'code', 'name', 'startTime', 'endTime', 'facilityId', 'isActive', 'color']) assert.ok(k in types[0], `勤務区分に ${k}`);
  const d = types.find((t) => t.code === 'D');
  assert.equal((await c.app.shifts.getPlans({ facilityId: fid, targetMonth: '2026-11' })).length, 0, '起動直後は計画 0');
  await assert.rejects(c.app.shifts.postPlans({ facilityId: fid, body: { facilityId: fid } }), (e) => e.status === 400 && /targetMonth/.test(e.message));
  const plan = await c.app.shifts.postPlans({ facilityId: fid, body: { facilityId: fid, targetMonth: '2026-11' } });
  assert.equal(plan.status, 'draft'); assert.equal(plan.revision, 1); assert.match(plan.id, /^shplan_/);
  const detail = await c.app.shifts.getPlansById({ id: plan.id, facilityId: fid });
  assert.deepEqual(Object.keys(detail), ['plan', 'assignments', 'conflicts']);
  // 本物は必須項目の無い割当を黙って捨てる。模擬サーバは 400 で止めて形を hint に出す
  await assert.rejects(c.app.shifts.putPlansByIdAssignments({ id: plan.id, facilityId: fid, body: { assignments: [{ userId: 'st_01', date: '2026-11-05', shiftTypeId: d.id }] } }), (e) => e.status === 400 && /startTime/.test(e.message) && /黙って捨て/.test(e.hint));
  const put = await c.app.shifts.putPlansByIdAssignments({ id: plan.id, facilityId: fid, body: { assignments: [{ userId: 'st_01', date: '2026-11-05', startTime: d.startTime, endTime: d.endTime, shiftType: d.code }], reason: 'test' } });
  assert.equal(put.assignments.length, 1); assert.equal(put.assignments[0].shiftType, 'D'); assert.match(put.assignments[0].id, /^shasg_/); assert.deepEqual(put.conflicts, []);
  const after = await c.app.shifts.getPlansById({ id: plan.id, facilityId: fid });
  assert.equal(after.plan.revision, 2); assert.equal(after.assignments.length, 1);
  // 同じ人・同じ日に重なる 2 件 → double-booking
  const dup = await c.app.shifts.putPlansByIdAssignments({ id: plan.id, facilityId: fid, body: { assignments: [{ userId: 'st_01', date: '2026-11-05', startTime: '09:00', endTime: '18:00' }, { userId: 'st_01', date: '2026-11-05', startTime: '10:00', endTime: '12:00' }] } });
  assert.equal(dup.conflicts.length, 1); assert.equal(dup.conflicts[0].kind, 'double-booking'); assert.equal(dup.conflicts[0].assignmentIds.length, 2); assert.ok(dup.conflicts[0].message); assert.equal(dup.assignments[0].shiftType, 'day', 'shiftType の既定は day (本物と同じ)');
  const hist = await c.app.shifts.getPlansByIdHistory({ id: plan.id, facilityId: fid });
  assert.equal(hist.length, 2); assert.deepEqual(hist[0].after, { count: 2 }); assert.deepEqual(hist[1].before, { count: 0 });
  assert.equal((await c.app.shifts.getPlans({ facilityId: fid })).length, 1);
  assert.deepEqual(await c.app.shifts.getPreferences({ facilityId: fid }), []);
  // 人事系
  const emp = await c.app.platform.getEmployees({ facilityId: fid });
  assert.ok(emp.employees.length >= 1); for (const k of ['authUserId', 'jobClassCode', 'positionName', 'jobGrade', 'evaluationTarget', 'facilityIds', 'qualifications']) assert.ok(k in emp.employees[0], `従業員に ${k}`);
  assert.ok((await c.app.platform.getQualifiedPersons({ facilityId: fid })).qualifiedPersons.length >= 1);
  assert.deepEqual(await c.app.trainings.get({ facilityId: fid }), { items: [] });
  const fte = await c.app.platform.getFte({ facilityId: fid, month: '2026-11' });
  assert.equal(fte.month, '2026-11'); assert.ok('totalFte' in fte.summary);
  assert.deepEqual(await c.app.staffingStandards.get({ facilityId: fid }), { items: [] });
  // スコープ検査は本物と同じ
  const c2 = createCposClient({ baseUrl: f.baseUrl, token: 'cpos_app_limited', fetch: f.fetch });   // seed のトークン: shifts:read が無い
  await assert.rejects(c2.app.shifts.getShiftTypes({ facilityId: 'fac_sakura' }), (e) => e.status === 403 && /shifts:read/.test(e.message));
});

test('KIT 模擬サーバ: シフトの更新系 (勤務区分の登録/削除、必要人員の登録/削除、勤務希望の保存/提出、計画の確定/公開) が通る', async () => {
  const f = createFakeCpos();
  const c = createCposClient({ baseUrl: f.baseUrl, token: 'cpos_app_x', fetch: f.fetch });
  const fid = (await c.facilities.list())[0].id;
  await assert.rejects(c.app.shifts.postShiftTypes({ facilityId: fid, body: { code: 'N' } }), (e) => e.status === 400 && /name/.test(e.message));
  const n = await c.app.shifts.postShiftTypes({ facilityId: fid, body: { facilityId: fid, code: 'N', name: '夜勤', startTime: '17:00', endTime: '09:00' } });
  assert.match(n.id, /^shtype_/); assert.equal(n.facilityId, fid);
  assert.ok((await c.app.shifts.getShiftTypes({ facilityId: fid })).some((t) => t.id === n.id), '登録した勤務区分が一覧に出る');
  await c.app.shifts.deleteShiftTypesById({ id: n.id, facilityId: fid });
  assert.ok(!(await c.app.shifts.getShiftTypes({ facilityId: fid })).some((t) => t.id === n.id), '消えた');
  await assert.rejects(c.app.shifts.postStaffingRequirements({ facilityId: fid, body: { facilityId: fid, role: 'nurse', requiredCount: 1, dayOfWeek: 9 } }), (e) => e.status === 400);
  const rq = await c.app.shifts.postStaffingRequirements({ facilityId: fid, body: { facilityId: fid, role: 'nurse', requiredCount: 2, dayOfWeek: 1 } });
  assert.equal((await c.app.shifts.getStaffingRequirements({ facilityId: fid })).length, 1);
  await c.app.shifts.deleteStaffingRequirementsById({ id: rq.id, facilityId: fid });
  assert.equal((await c.app.shifts.getStaffingRequirements({ facilityId: fid })).length, 0);
  await assert.rejects(c.app.shifts.postPreferences({ facilityId: fid, body: { facilityId: fid, targetMonth: '2026-11' } }), (e) => e.status === 400 && /userId/.test(e.message), 'トークン経由は userId 必須');
  const pf = await c.app.shifts.postPreferences({ facilityId: fid, body: { facilityId: fid, targetMonth: '2026-11', userId: 'st_01', unavailableDays: ['2026-11-03'] } });
  assert.equal(pf.status, 'draft');
  const sub = await c.app.shifts.postPreferencesByIdSubmit({ id: pf.id, facilityId: fid });
  assert.equal(sub.status, 'submitted'); assert.ok(sub.submittedAt);
  assert.equal((await c.app.shifts.getPreferences({ facilityId: fid, targetMonth: '2026-11' })).length, 1);
  const plan = await c.app.shifts.postPlans({ facilityId: fid, body: { facilityId: fid, targetMonth: '2026-11' } });
  await assert.rejects(c.app.shifts.postPlansByIdPublish({ id: plan.id, facilityId: fid }), (e) => e.status === 409, '確定していない計画は公開できない (本物と同じ)');
  assert.equal((await c.app.shifts.postPlansByIdFinalize({ id: plan.id, facilityId: fid })).status, 'finalized');
  assert.equal((await c.app.shifts.postPlansByIdPublish({ id: plan.id, facilityId: fid })).status, 'published');
});
