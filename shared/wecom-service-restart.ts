/**
 * wecom launchd 服务自动重启（推送失败时恢复 WebSocket）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const SERVICE_NAME = 'com.wecom-cursor-claw';
const PLIST_PATH = resolve(homedir(), 'Library/LaunchAgents', `${SERVICE_NAME}.plist`);
const COOLDOWN_MS = 120_000;

export function getWecomRestartCooldownPath(root: string): string {
	return resolve(root, '.cache/wecom-restart-cooldown.json');
}

/** 是否像 WebSocket/连接类推送失败（值得重启服务） */
export function isWecomConnectionPushError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return (
		msg.includes('websocket not connected') ||
		msg.includes('unable to send data') ||
		msg.includes('connection ended') ||
		msg.includes('disconnected') ||
		msg.includes('not connected')
	);
}

/**
 * 安排 launchd 重启 wecom 服务（detach，不阻塞当前进程）。
 * 2 分钟内最多触发一次，避免重启风暴。
 */
export function scheduleWecomServiceRestart(root: string, reason: string): boolean {
	const cooldownPath = getWecomRestartCooldownPath(root);
	const now = Date.now();
	mkdirSync(dirname(cooldownPath), { recursive: true });

	if (existsSync(cooldownPath)) {
		try {
			const last = JSON.parse(readFileSync(cooldownPath, 'utf-8')) as { atMs?: number };
			if (last.atMs && now - last.atMs < COOLDOWN_MS) {
				console.warn(`[wecom-restart] 跳过重启（冷却中）: ${reason}`);
				return false;
			}
		} catch {
			/* ignore */
		}
	}

	if (!existsSync(PLIST_PATH)) {
		console.warn(`[wecom-restart] plist 不存在，无法重启: ${PLIST_PATH}`);
		return false;
	}

	writeFileSync(cooldownPath, JSON.stringify({ atMs: now, reason }), 'utf-8');
	console.warn(`[wecom-restart] 推送失败，安排重启 wecom 服务: ${reason}`);

	const script = [
		'sleep 1',
		`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`,
		'sleep 2',
		`launchctl load "${PLIST_PATH}" 2>/dev/null || true`,
	].join('; ');

	spawn('/bin/bash', ['-c', script], {
		detached: true,
		stdio: 'ignore',
	}).unref();

	return true;
}
