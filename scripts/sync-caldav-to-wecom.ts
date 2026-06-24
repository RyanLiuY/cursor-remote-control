/**
 * 将 CalDAV 日历（如钉钉）同步到企业微信日程
 *
 * 用法:
 *   CALDAV_USER=u_xxx CALDAV_PASS=xxx node scripts/sync-caldav-to-wecom.ts
 *
 * 可选环境变量:
 *   CALDAV_SERVER   默认 calendar.dingtalk.com
 *   SYNC_DAYS_PAST  默认 1（同步过去 N 天起）
 *   SYNC_DAYS_FUTURE 默认 30
 *   DRY_RUN=1       只预览，不写入
 *   CREATE_TODOS=1  同步日程时同时创建同开始时间的待办（默认开启）
 *   SYNC_STATE_PATH 映射文件路径，默认 .cache/caldav-wecom-sync.json
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const ROOT = resolve(import.meta.dirname, '..');
const WECOM_CLI = process.env.WECOM_CLI ?? '/Users/ryanliu/.local/node/bin/wecom-cli';
const CALDAV_USER = process.env.CALDAV_USER;
const CALDAV_PASS = process.env.CALDAV_PASS;
const CALDAV_SERVER = process.env.CALDAV_SERVER ?? 'calendar.dingtalk.com';
const SYNC_DAYS_PAST = Number(process.env.SYNC_DAYS_PAST ?? '1');
const SYNC_DAYS_FUTURE = Number(process.env.SYNC_DAYS_FUTURE ?? '29');
const DRY_RUN = process.env.DRY_RUN === '1';
const CREATE_TODOS = process.env.CREATE_TODOS !== '0';
const SYNC_STATE_PATH = process.env.SYNC_STATE_PATH ?? resolve(ROOT, '.cache/caldav-wecom-sync.json');
const TZ = 'Asia/Shanghai';

type CaldavEvent = {
	uid: string;
	summary: string;
	description?: string;
	location?: string;
	start: Date;
	end: Date;
	isWholeDay: boolean;
};

type SyncState = Record<string, { scheduleId: string; todoId?: string; syncedAt: string }>;

function requireEnv(name: string, value: string | undefined): string {
	if (!value) throw new Error(`缺少环境变量 ${name}`);
	return value;
}

function formatWecomTime(date: Date): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: TZ,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	}).formatToParts(date);
	const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
	return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function parseWecomCliJson(raw: string): unknown {
	const outer = JSON.parse(raw) as { result?: { content?: Array<{ text?: string }> } };
	const text = outer.result?.content?.[0]?.text;
	if (!text) throw new Error(`无法解析 wecom-cli 输出: ${raw.slice(0, 200)}`);
	return JSON.parse(text);
}

function runWecom(domain: 'schedule' | 'todo', action: string, payload: Record<string, unknown>): Record<string, unknown> {
	const raw = execFileSync(WECOM_CLI, [domain, action, JSON.stringify(payload)], { encoding: 'utf-8' });
	const parsed = parseWecomCliJson(raw) as Record<string, unknown>;
	return parsed;
}

function runWecomOrThrow(domain: 'schedule' | 'todo', action: string, payload: Record<string, unknown>): Record<string, unknown> {
	const parsed = runWecom(domain, action, payload);
	if (parsed.errcode !== 0) {
		throw new Error(`wecom ${domain}.${action} 失败: ${parsed.errmsg ?? JSON.stringify(parsed)}`);
	}
	return parsed;
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&#13;/g, '\r')
		.replace(/&#10;/g, '\n')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"');
}

function extractCalendarData(raw: unknown): string | undefined {
	if (typeof raw === 'string') return decodeHtmlEntities(raw);
	if (raw && typeof raw === 'object' && '#text' in raw) {
		const text = (raw as { '#text'?: unknown })['#text'];
		return typeof text === 'string' ? decodeHtmlEntities(text) : undefined;
	}
	return undefined;
}

function unfoldIcs(text: string): string {
	return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function parseIcsDate(value: string, params: Record<string, string>): Date {
	const clean = value.trim();
	if (/^\d{8}$/.test(clean)) {
		const y = Number(clean.slice(0, 4));
		const m = Number(clean.slice(4, 6));
		const d = Number(clean.slice(6, 8));
		if (params.TZID || params.tzid) {
			return new Date(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+08:00`);
		}
		return new Date(Date.UTC(y, m - 1, d));
	}
	const m = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
	if (!m) throw new Error(`无法解析 ICS 时间: ${value}`);
	const [, y, mo, d, h, mi, s, z] = m;
	if (z) {
		return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
	}
	return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
}

function parseIcsEvents(icsText: string): CaldavEvent[] {
	const unfolded = unfoldIcs(icsText);
	const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
	const events: CaldavEvent[] = [];

	for (const block of blocks) {
		const body = block.split('END:VEVENT')[0] ?? '';
		const lines = body.split(/\r?\n/).filter(Boolean);
		const fields: Record<string, { value: string; params: Record<string, string> }> = {};

		for (const line of lines) {
			const sep = line.indexOf(':');
			if (sep <= 0) continue;
			const left = line.slice(0, sep);
			const value = line.slice(sep + 1);
			const [name, ...paramParts] = left.split(';');
			const params: Record<string, string> = {};
			for (const part of paramParts) {
				const [k, v] = part.split('=');
				if (k && v) params[k.toUpperCase()] = v;
			}
			fields[name.toUpperCase()] = { value, params };
		}

		const uid = fields.UID?.value;
		const summary = fields.SUMMARY?.value?.trim();
		const dtStart = fields.DTSTART;
		const dtEnd = fields.DTEND;
		if (!uid || !summary || !dtStart) continue;

		const start = parseIcsDate(dtStart.value, dtStart.params);
		const isWholeDay = /^\d{8}$/.test(dtStart.value.trim());
		let end: Date;
		if (dtEnd) {
			end = parseIcsDate(dtEnd.value, dtEnd.params);
		} else if (isWholeDay) {
			end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
		} else {
			end = new Date(start.getTime() + 60 * 60 * 1000);
		}

		events.push({
			uid,
			summary,
			description: fields.DESCRIPTION?.value,
			location: fields.LOCATION?.value,
			start,
			end,
			isWholeDay,
		});
	}

	return events;
}

async function fetchCaldavEvents(user: string, pass: string, start: Date, end: Date): Promise<CaldavEvent[]> {
	const base = `https://${CALDAV_SERVER}/dav/${user}/primary/`;
	const startUtc = start.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	const endUtc = end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${startUtc}" end="${endUtc}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

	const auth = Buffer.from(`${user}:${pass}`).toString('base64');
	const res = await fetch(base, {
		method: 'REPORT',
		headers: {
			Authorization: `Basic ${auth}`,
			Depth: '1',
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body,
	});
	if (!res.ok) {
		throw new Error(`CalDAV 请求失败: HTTP ${res.status} ${await res.text()}`);
	}

	const xml = await res.text();
	const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, textNodeName: '#text' });
	const doc = parser.parse(xml) as { multistatus?: { response?: unknown } };
	const responses = doc.multistatus?.response;
	const responseList = Array.isArray(responses) ? responses : responses ? [responses] : [];

	const events: CaldavEvent[] = [];
	for (const item of responseList) {
		const propstat = item?.propstat;
		const stats = Array.isArray(propstat) ? propstat : propstat ? [propstat] : [];
		for (const stat of stats) {
			const calendarData = extractCalendarData(stat?.prop?.['calendar-data']);
			if (!calendarData) continue;
			events.push(...parseIcsEvents(calendarData));
		}
	}

	const dedup = new Map<string, CaldavEvent>();
	for (const event of events) dedup.set(event.uid, event);
	return [...dedup.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

function loadSyncState(): SyncState {
	if (!existsSync(SYNC_STATE_PATH)) return {};
	return JSON.parse(readFileSync(SYNC_STATE_PATH, 'utf-8')) as SyncState;
}

function saveSyncState(state: SyncState): void {
	mkdirSync(dirname(SYNC_STATE_PATH), { recursive: true });
	writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

function listWecomSchedules(start: Date, end: Date): Set<string> {
	const keys = new Set<string>();
	const cursor = new Date(start);
	cursor.setHours(0, 0, 0, 0);
	const wecomMaxEnd = new Date();
	wecomMaxEnd.setDate(wecomMaxEnd.getDate() + 29);
	wecomMaxEnd.setHours(23, 59, 59, 0);

	while (cursor <= end) {
		const dayStart = new Date(cursor);
		let dayEnd = new Date(cursor);
		dayEnd.setHours(23, 59, 59, 0);
		if (dayEnd > wecomMaxEnd) dayEnd = new Date(wecomMaxEnd);
		if (dayStart > wecomMaxEnd) break;

		const list = runWecom('schedule', 'get_schedule_list_by_range', {
			start_time: formatWecomTime(dayStart).slice(0, 19),
			end_time: formatWecomTime(dayEnd).slice(0, 19),
		});
		if (list.errcode !== 0) {
			console.warn(`[sync] 跳过企业微信日程查询 ${formatWecomTime(dayStart).slice(0, 10)}: ${list.errmsg}`);
			cursor.setDate(cursor.getDate() + 1);
			continue;
		}

		const ids = (list.schedule_id_list as string[] | undefined) ?? [];
		for (let i = 0; i < ids.length; i += 50) {
			const batch = ids.slice(i, i + 50);
			if (batch.length === 0) continue;
			const details = runWecomOrThrow('schedule', 'get_schedule_detail', {
				schedule_id_list: batch,
			}) as { schedule_list?: Array<{ summary?: string; start_time?: number }> };

			for (const item of details.schedule_list ?? []) {
				if (!item.summary || !item.start_time) continue;
				keys.add(`${item.summary}::${item.start_time}`);
			}
		}

		cursor.setDate(cursor.getDate() + 1);
	}

	return keys;
}

async function main(): Promise<void> {
	const user = requireEnv('CALDAV_USER', CALDAV_USER);
	const pass = requireEnv('CALDAV_PASS', CALDAV_PASS);

	const now = new Date();
	const rangeStart = new Date(now);
	rangeStart.setDate(rangeStart.getDate() - SYNC_DAYS_PAST);
	rangeStart.setHours(0, 0, 0, 0);
	const rangeEnd = new Date(now);
	rangeEnd.setDate(rangeEnd.getDate() + SYNC_DAYS_FUTURE);
	rangeEnd.setHours(23, 59, 59, 999);

	console.log(`[sync] 拉取 CalDAV 日程: ${formatWecomTime(rangeStart)} ~ ${formatWecomTime(rangeEnd)}`);
	const events = await fetchCaldavEvents(user, pass, rangeStart, rangeEnd);
	console.log(`[sync] CalDAV 共 ${events.length} 条事件`);

	const syncState = loadSyncState();
	const existingKeys = listWecomSchedules(rangeStart, rangeEnd);

	let created = 0;
	let skipped = 0;

	for (const event of events) {
		if (syncState[event.uid]?.scheduleId) {
			skipped++;
			continue;
		}

		const startKey = `${event.summary}::${Math.floor(event.start.getTime() / 1000)}`;
		if (existingKeys.has(startKey)) {
			skipped++;
			continue;
		}

		const schedulePayload = {
			schedule: {
				start_time: formatWecomTime(event.start),
				end_time: formatWecomTime(event.end),
				summary: event.summary.slice(0, 128),
				...(event.description ? { description: event.description.slice(0, 1000) } : {}),
				...(event.location ? { location: event.location.slice(0, 128) } : {}),
				...(event.isWholeDay ? { is_whole_day: 1 } : {}),
				reminders: { is_remind: 1, remind_before_event_secs: 900, timezone: 8 },
			},
		};

		console.log(`[sync] ${DRY_RUN ? '预览' : '创建'}: ${formatWecomTime(event.start)} ${event.summary}`);
		if (DRY_RUN) {
			created++;
			continue;
		}

		const createdSchedule = runWecomOrThrow('schedule', 'create_schedule', schedulePayload) as { schedule_id?: string };
		const scheduleId = createdSchedule.schedule_id;
		if (!scheduleId) throw new Error(`创建日程失败: ${event.summary}`);

		let todoId: string | undefined;
		if (CREATE_TODOS) {
			const todo = runWecomOrThrow('todo', 'create_todo', {
				content: event.summary.slice(0, 200),
				remind_time: formatWecomTime(event.start),
			}) as { todo_id?: string };
			todoId = todo.todo_id;
		}

		syncState[event.uid] = {
			scheduleId,
			todoId,
			syncedAt: new Date().toISOString(),
		};
		existingKeys.add(startKey);
		created++;
	}

	if (!DRY_RUN) saveSyncState(syncState);
	console.log(`[sync] 完成: 新建 ${created}，跳过 ${skipped}`);
}

main().catch((err) => {
	console.error('[sync] 失败:', err instanceof Error ? err.message : err);
	process.exit(1);
});
