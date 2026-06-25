/**
 * 将 Markdown 推送到企业微信机器人（供 Cloud Automation / 本地脚本共用）
 *
 * 环境变量:
 *   WECOM_BOT_ID, WECOM_BOT_SECRET — 机器人凭据（直连 WebSocket 时必填）
 *   WECOM_CHAT_ID — 接收人 chatid（默认 LiuHaoCheng）
 *   WECOM_PUSH_DIRECT=1 — 强制 WebSocket 直连（忽略本地 server 队列）
 *
 * 用法:
 *   bun run scripts/push-wecom-markdown.ts --title "标题" --file report.md
 *   bun run scripts/push-wecom-markdown.ts --title "标题" --text "内容"
 *   echo "内容" | bun run scripts/push-wecom-markdown.ts --title "标题"
 *
 * 本地 wecom/server 运行时默认走推送队列，避免与长连接互踢。
 * 推送前自动检查 WebSocket；失败最多 3 次，间隔 5 分钟。
 */
import AiBot from '@wecom/aibot-node-sdk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	enqueueWecomPush,
	isWecomPushServerRunning,
} from '../shared/wecom-push-queue.ts';
import { runWithWecomPushGuard } from '../shared/wecom-push-guard.ts';

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

function parseArgs(argv: string[]) {
	let title = 'Automation 推送';
	let file: string | undefined;
	let text: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--title' && argv[i + 1]) title = argv[++i]!;
		else if (a === '--file' && argv[i + 1]) file = argv[++i]!;
		else if (a === '--text' && argv[i + 1]) text = argv[++i]!;
	}
	return { title, file, text };
}

async function pushViaWebSocket(chatid: string, title: string, body: string, env: Record<string, string>) {
	const botId = env.WECOM_BOT_ID;
	const secret = env.WECOM_BOT_SECRET;
	if (!botId || !secret) {
		throw new Error('缺少 WECOM_BOT_ID / WECOM_BOT_SECRET（Cloud Agent 密钥或 wecom/.env）');
	}

	const wsClient = new AiBot.WSClient({ botId, secret });
	await new Promise<void>((resolveConnect, reject) => {
		const timeout = setTimeout(() => reject(new Error('企业微信连接超时')), 20000);
		wsClient.once('authenticated', () => {
			clearTimeout(timeout);
			resolveConnect();
		});
		wsClient.once('error', (err) => {
			clearTimeout(timeout);
			reject(err);
		});
		wsClient.connect();
	});

	const { chunkWecomMarkdown } = await import('../shared/wecom-push-queue.ts');
	const chunks = chunkWecomMarkdown(body.trim());
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		const heading =
			chunks.length > 1 ? `**${title}** (${i + 1}/${chunks.length})\n\n` : `**${title}**\n\n`;
		await wsClient.sendMessage(chatid, {
			msgtype: 'markdown',
			markdown: { content: `${heading}${chunk.slice(0, 3000)}` },
		});
		if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 400));
	}

	wsClient.disconnect();
	console.log(`[push-wecom] WebSocket 已推送 ${chunks.length} 条消息到 ${chatid}`);
}

async function deliver(chatid: string, title: string, body: string, env: Record<string, string>, mode: 'queue' | 'direct') {
	const useLocalQueue = mode === 'queue' || (env.WECOM_PUSH_DIRECT !== '1' && isWecomPushServerRunning(ROOT));
	if (useLocalQueue && env.WECOM_PUSH_DIRECT !== '1') {
		enqueueWecomPush(ROOT, { chatid, title, body: body.trim() });
		console.log(`[push-wecom] 已写入本地推送队列 → ${chatid}（由 wecom/server 发送）`);
		return;
	}
	await pushViaWebSocket(chatid, title, body, env);
}

async function main() {
	const { title, file, text } = parseArgs(process.argv.slice(2));
	const env = loadEnv();
	const chatid = env.WECOM_CHAT_ID || 'LiuHaoCheng';

	let body = text ?? '';
	if (file) body = readFileSync(resolve(file), 'utf-8');
	if (!body && !process.stdin.isTTY) {
		body = readFileSync(0, 'utf-8');
	}
	if (!body.trim()) throw new Error('无推送内容，请使用 --file / --text 或 stdin');

	await runWithWecomPushGuard(
		ROOT,
		env,
		(mode) => deliver(chatid, title, body, env, mode),
		{ label: 'Markdown 推送' },
	);
	process.exit(0);
}

main().catch((err) => {
	console.error('[push-wecom] 失败:', err instanceof Error ? err.message : err);
	process.exit(1);
});
