/**
 * 本地企微 Markdown 推送队列
 *
 * 当 wecom/server 长连接已占用 Bot WebSocket 时，push 脚本写入队列，
 * 由 server 通过现有 wsClient 发送，避免互踢断线。
 * Cloud Automation 无本地 server，仍走 WebSocket 直连。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface WecomPushItem {
	chatid: string;
	title: string;
	body: string;
}

export function chunkWecomMarkdown(content: string, max = 2800): string[] {
	if (content.length <= 3000) return [content];
	const chunks: string[] = [];
	for (let i = 0; i < content.length; i += max) chunks.push(content.slice(i, i + max));
	return chunks;
}

export function getWecomPushQueuePath(root: string): string {
	return resolve(root, '.cache/wecom-push-queue.jsonl');
}

export function getWecomPushServerPidPath(root: string): string {
	return resolve(root, '.cache/wecom-push-server.pid');
}

export function writeWecomPushServerPid(root: string): void {
	const dir = resolve(root, '.cache');
	mkdirSync(dir, { recursive: true });
	writeFileSync(getWecomPushServerPidPath(root), String(process.pid), 'utf-8');
}

export function clearWecomPushServerPid(root: string): void {
	try {
		unlinkSync(getWecomPushServerPidPath(root));
	} catch {
		/* ignore */
	}
}

export function isWecomPushServerRunning(root: string): boolean {
	const pidPath = getWecomPushServerPidPath(root);
	if (!existsSync(pidPath)) return false;
	const pid = Number.parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function enqueueWecomPush(root: string, item: WecomPushItem): void {
	const queuePath = getWecomPushQueuePath(root);
	mkdirSync(dirname(queuePath), { recursive: true });
	appendFileSync(queuePath, `${JSON.stringify(item)}\n`, 'utf-8');
}

export async function drainWecomPushQueue(
	root: string,
	send: (chatid: string, markdownContent: string) => Promise<void>,
): Promise<number> {
	const queuePath = getWecomPushQueuePath(root);
	if (!existsSync(queuePath)) return 0;

	const raw = readFileSync(queuePath, 'utf-8');
	if (!raw.trim()) return 0;

	const lines = raw.split('\n').filter((line) => line.trim());
	writeFileSync(queuePath, '', 'utf-8');

	let sent = 0;
	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx]!;
		try {
			const item = JSON.parse(line) as WecomPushItem;
			const chunks = chunkWecomMarkdown(item.body.trim());
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i]!;
				const heading =
					chunks.length > 1
						? `**${item.title}** (${i + 1}/${chunks.length})\n\n`
						: `**${item.title}**\n\n`;
				await send(item.chatid, `${heading}${chunk.slice(0, 3000)}`);
				if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 400));
			}
			sent++;
		} catch (err) {
			console.error('[wecom-push-queue] 处理队列项失败:', err instanceof Error ? err.message : err);
			for (let j = lineIdx; j < lines.length; j++) {
				appendFileSync(queuePath, `${lines[j]}\n`, 'utf-8');
			}
			throw err;
		}
	}
	return sent;
}
