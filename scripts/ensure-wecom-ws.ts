/**
 * 推送 / Automation 触发前检查企业微信 WebSocket（最多 3 次，间隔 5 分钟）
 *
 * 用法: bun run scripts/ensure-wecom-ws.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureWecomPushReady } from '../shared/wecom-push-guard.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(ROOT, 'wecom/.env');

function loadEnv(): Record<string, string> {
	const merged: Record<string, string> = {};
	if (existsSync(ENV_PATH)) {
		for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const [key, ...vals] = trimmed.split('=');
			if (!key) continue;
			let val = vals.join('=').trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			merged[key.trim()] = val;
		}
	}
	for (const [k, v] of Object.entries(process.env)) {
		if (v) merged[k] = v;
	}
	return merged;
}

async function main() {
	const env = loadEnv();
	const mode = await ensureWecomPushReady(ROOT, env);
	console.log(`[ensure-wecom-ws] OK mode=${mode}`);
	process.exit(0);
}

main().catch((err) => {
	console.error('[ensure-wecom-ws] 失败:', err instanceof Error ? err.message : err);
	process.exit(1);
});
