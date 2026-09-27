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

test('capabilities は本物と同じ形で返り、模擬サーバが持つ機能だけを載せる', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  const cap = await c.platform.capabilities();
  assert.equal(cap.server, 'cpos');
  assert.equal(cap.features.masterUsers.masterUserId, true);
  assert.equal(cap.features.masterUsers.identifierAliases, true, '過去の番号・仮番号で引ける');
  assert.equal(cap.features.appData.userRef, true, 'AppData の封筒の利用者');
  // 本物の規約: 無い機能はキーごと無い (値は常に true)。模擬サーバに無いものを true と言わない
  assert.equal(cap.features.masterUsers.merge, undefined);
  assert.equal(cap.features.masterUsers.changeInsuredNumber, undefined);
  assert.equal(cap.features.appData.attachments, undefined);
  assert.equal(cap.features.careDocuments, undefined);
  for (const group of Object.values(cap.features)) for (const v of Object.values(group)) assert.equal(v, true);
});

test('KIT 模擬サーバ: 利用者は masterUserId・現在の番号・過去の番号・仮番号のどれでも引ける (master-users/{key}・name-map)', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  // seed: mu_0021 は番号が 0000000021 → 0000000121 に変わった人、mu_0022 は仮番号 (tmp-*) の人
  for (const key of ['mu_0021', '0000000121', '0000000021']) {
    const u = await c.app.platform.getMasterUsersByInsuredNumber({ insuredNumber: key });
    assert.equal(u.masterUserId, 'mu_0021', key);
    assert.equal(u.insuredNumber, '0000000121', '応答の insuredNumber は現在の保存キー');
    assert.ok(!('pastInsuredNumbers' in u), '模擬サーバだけの欄は応答に出さない');
  }
  assert.equal((await c.app.platform.getMasterUsersByInsuredNumber({ insuredNumber: 'tmp-k7Qm2xLp' })).masterUserId, 'mu_0022');
  await assert.rejects(c.app.platform.getMasterUsersByInsuredNumber({ insuredNumber: '0000009999' }), (e) => e.status === 404);
  await assert.rejects(c.app.platform.getMasterUsersByInsuredNumber({ insuredNumber: 'mu_0013', facilityId: 'fac_sakura' }), (e) => e.status === 404, 'その事業所の利用者でなければ 404 (本物と同じ)');
  // 番号 → 本人の対応表。過去の番号は kind: 'alias' で今の番号と mu に寄る
  const map = await c.app.platform.getMasterUsersNameMap({ facilityId: 'fac_sakura' });
  const alias = map.items.find((i) => i.insuredNumber === '0000000021');
  assert.deepEqual(alias, { masterUserId: 'mu_0021', insuredNumber: '0000000021', name: alias.name, currentInsuredNumber: '0000000121', kind: 'alias' });
  assert.ok(map.items.some((i) => i.insuredNumber === 'tmp-k7Qm2xLp' && i.kind === 'current' && i.masterUserId === 'mu_0022'));
  assert.ok(!(await c.raw('GET', '/api/platform/master-users/name-map', { facilityId: 'fac_sakura', query: { includeAliases: 'false' } })).items.some((i) => i.kind === 'alias'));
  // 一覧の q は本物と同じく番号にも当たる
  assert.deepEqual((await c.masterUsers.list({ facilityId: 'fac_sakura', q: '0000000121' })).map((u) => u.masterUserId), ['mu_0021']);
});

test('KIT 模擬サーバ: displayInsuredNumber は platform/facilities/{id}/users に載り、仮番号の人は null (本物の形)', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  const r = await c.app.platform.getFacilitiesByFacilityIdUsers({ facilityId: 'fac_sakura' });
  assert.equal(r.ok, true);
  for (const k of ['id', 'insuredNumber', 'masterUserId', 'displayInsuredNumber', 'name', 'furigana', 'careLevel', 'extras']) assert.ok(k in r.users[0], `項目 ${k} がある`);
  const byMu = new Map(r.users.map((u) => [u.masterUserId, u]));
  assert.equal(byMu.get('mu_0001').displayInsuredNumber, '0000000001');
  assert.equal(byMu.get('mu_0021').displayInsuredNumber, '0000000121');
  assert.equal(byMu.get('mu_0022').displayInsuredNumber, null, '仮番号は帳票に出さない');
  assert.equal(byMu.get('mu_0022').insuredNumber, 'tmp-k7Qm2xLp');
  const limited = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_limited', fetch: fake.fetch });
  await assert.rejects(limited.app.platform.getFacilitiesByFacilityIdUsers({ facilityId: 'fac_momiji' }), (e) => e.status === 403 && e.error === 'facility-access-denied');
});

test('KIT 模擬サーバ: AppData の封筒の利用者は保存キーと masterUserId に揃い、一覧は本人の全キーで引ける', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  const f = 'fac_sakura';
  const post = (body) => c.app.appData.postByAppIdByResource({ appId: 'demo', resource: 'notes', facilityId: f, body: { facilityId: f, ...body } });
  const byOld = await post({ data: { t: 1 }, insuredNumber: '0000000021' });
  assert.equal(byOld.insuredNumber, '0000000121', '過去の番号で送っても今の保存キーに揃う');
  assert.equal(byOld.masterUserId, 'mu_0021');
  const byMu = await post({ data: { t: 2 }, insuredNumber: 'mu_0022' });
  assert.deepEqual([byMu.insuredNumber, byMu.masterUserId], ['tmp-k7Qm2xLp', 'mu_0022']);
  const muOnly = await post({ data: { t: 3 }, masterUserId: 'mu_0001' });
  assert.deepEqual([muOnly.insuredNumber, muOnly.masterUserId], ['0000000001', 'mu_0001'], 'insuredNumber が無ければ masterUserId で本人を引く');
  const unknown = await post({ data: { t: 4 }, insuredNumber: 'x-unknown' });
  assert.deepEqual([unknown.insuredNumber, unknown.masterUserId], ['x-unknown', null], '本人に着地しなければ受け取った値のまま、mu は付けない');
  const none = await post({ data: { t: 5 } });
  assert.deepEqual([none.insuredNumber, none.masterUserId], [null, null]);
  // 一覧: どのキーで引いても本人の行だけ
  for (const key of ['0000000021', '0000000121', 'mu_0021']) {
    const rows = await c.app.appData.getByAppIdByResource({ appId: 'demo', resource: 'notes', facilityId: f, insuredNumber: key });
    assert.deepEqual(rows.map((r) => r.id), [byOld.id], key);
  }
  assert.equal((await c.app.appData.getByAppIdByResource({ appId: 'demo', resource: 'notes', facilityId: f })).length, 5, '絞らなければ全部');
  // 更新: 送らなければ封筒はそのまま、送れば付け直す (mu も)、null は外す
  const put = (id, body) => c.app.appData.putByAppIdByResourceById({ appId: 'demo', resource: 'notes', id, facilityId: f, body });
  assert.equal((await put(byOld.id, { data: { t: 11 } })).masterUserId, 'mu_0021');
  const moved = await put(byOld.id, { data: { t: 12 }, insuredNumber: '0000000002' });
  assert.deepEqual([moved.insuredNumber, moved.masterUserId], ['0000000002', 'mu_0002']);
  const cleared = await put(byOld.id, { data: { t: 13 }, insuredNumber: null });
  assert.deepEqual([cleared.insuredNumber, cleared.masterUserId], [null, null]);
});

test('KIT 模擬サーバ: 保存時の付与と一覧のキーは本物と同じ (CPOS のコードと 2026-09-27 の実測)', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  const f = 'fac_sakura';
  const post = (body) => c.app.appData.postByAppIdByResource({ appId: 'demo', resource: 'notes', facilityId: f, body: { facilityId: f, ...body } });
  const put = (id, body) => c.app.appData.putByAppIdByResourceById({ appId: 'demo', resource: 'notes', id, facilityId: f, body });
  // 名簿に居ない mu_* でも、保存キーが mu なら本物は mu に入れる (保存時の付与)
  const ghost = await post({ data: { t: 1 }, insuredNumber: 'mu_ghost01' });
  assert.deepEqual([ghost.insuredNumber, ghost.masterUserId], ['mu_ghost01', 'mu_ghost01']);
  const moved = await put(ghost.id, { insuredNumber: 'mu_ghost02' });
  assert.deepEqual([moved.insuredNumber, moved.masterUserId], ['mu_ghost02', 'mu_ghost02'], 'mu_* への付け替えも付与が付け直す');
  assert.deepEqual(moved.data, { t: 1 }, 'PUT は data を省ける (本物と同じ)');
  // mu で送っても、着地すれば保存キー (番号) に揃い、番号でも mu でも引ける
  const muKeyed = await post({ data: { t: 2 }, insuredNumber: 'mu_0001' });
  assert.equal(muKeyed.insuredNumber, '0000000001');
  for (const key of ['0000000001', 'mu_0001']) {
    const rows = await c.app.appData.getByAppIdByResource({ appId: 'demo', resource: 'notes', facilityId: f, insuredNumber: key });
    assert.deepEqual(rows.map((r) => r.id), [muKeyed.id], key);
  }
  // 番号で引くとき、本人の mu は引くキーに入らない (封筒が mu のまま残った行は番号では当たらない。本物と同じ)
  const store = [...fake.state.appData.values()].find((m) => m.has(muKeyed.id));
  store.get(muKeyed.id).insuredNumber = 'mu_0001';
  assert.deepEqual((await c.app.appData.getByAppIdByResource({ appId: 'demo', resource: 'notes', facilityId: f, insuredNumber: '0000000001' })).map((r) => r.id), []);
  assert.deepEqual((await c.app.appData.getByAppIdByResource({ appId: 'demo', resource: 'notes', facilityId: f, insuredNumber: 'mu_0001' })).map((r) => r.id), [muKeyed.id]);
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
