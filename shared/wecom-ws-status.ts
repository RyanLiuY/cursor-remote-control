/**
 * 本地 wecom/server WebSocket 连接状态（供推送前检查）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface WecomWsStatus {
	connected: boolean;
	atMs: number;
	pid?: number;
	reason?: string;
}

export function getWecomWsStatusPath(root: string): string {
	return resolve(root, '.cache/wecom-ws-status.json');
}

export function writeWecomWsStatus(root: string, status: WecomWsStatus): void {
	const path = getWecomWsStatusPath(root);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(status, null, 2));
}

export function readWecomWsStatus(root: string): WecomWsStatus | null {
	const path = getWecomWsStatusPath(root);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as WecomWsStatus;
	} catch {
		return null;
	}
}

/** 状态是否在 maxAgeMs 内更新且为已连接 */
export function isWecomWsReady(root: string, maxAgeMs = 120_000): boolean {
	const status = readWecomWsStatus(root);
	if (!status?.connected) return false;
	return Date.now() - status.atMs <= maxAgeMs;
}
