/**
 * 企业微信推送前 WebSocket 就绪检查 + 失败重试（Automation / 定时任务共用）
 */
import AiBot from '@wecom/aibot-node-sdk';
import { isWecomPushServerRunning } from './wecom-push-queue.js';
import { isWecomWsReady, readWecomWsStatus } from './wecom-ws-status.js';
import { scheduleWecomServiceRestart } from './wecom-service-restart.js';

export const WECOM_PUSH_MAX_ATTEMPTS = 3;
export const WECOM_PUSH_RETRY_MS = 300_000; // 5 分钟

export type WecomPushMode = 'queue' | 'direct';

export type WecomPushGuardOpts = {
	maxAttempts?: number;
	retryIntervalMs?: number;
	waitAfterRestartMs?: number;
	log?: (msg: string) => void;
};

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** 短连接探测 Bot WebSocket 是否可用（Cloud Automation / 无本地 server 时） */
export async function probeWecomWebSocket(
	env: Record<string, string>,
	timeoutMs = 20_000,
): Promise<void> {
	const botId = env.WECOM_BOT_ID;
	const secret = env.WECOM_BOT_SECRET;
	if (!botId || !secret) {
		throw new Error('缺少 WECOM_BOT_ID / WECOM_BOT_SECRET');
	}

	const wsClient = new AiBot.WSClient({ botId, secret });
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('企业微信 WebSocket 探测超时')), timeoutMs);
		const cleanup = () => {
			clearTimeout(timeout);
			wsClient.removeAllListeners('authenticated');
			wsClient.removeAllListeners('error');
		};
		wsClient.once('authenticated', () => {
			cleanup();
			resolve();
		});
		wsClient.once('error', (err) => {
			cleanup();
			reject(err instanceof Error ? err : new Error(String(err)));
		});
		wsClient.connect();
	});
	wsClient.disconnect();
}

async function waitForLocalWecomWs(
	root: string,
	opts: WecomPushGuardOpts,
): Promise<void> {
	const log = opts.log ?? ((m) => console.log(`[wecom-guard] ${m}`));
	const waitMs = opts.waitAfterRestartMs ?? 45_000;
	const deadline = Date.now() + waitMs;

	while (Date.now() < deadline) {
		if (isWecomWsReady(root)) {
			log('本地 wecom/server WebSocket 已就绪');
			return;
		}
		await sleep(2000);
	}

	const status = readWecomWsStatus(root);
	throw new Error(
		`本地 wecom/server WebSocket 未就绪${status?.reason ? ` (${status.reason})` : ''}`,
	);
}

async function ensureOnce(root: string, env: Record<string, string>, opts: WecomPushGuardOpts): Promise<WecomPushMode> {
	const log = opts.log ?? ((m) => console.log(`[wecom-guard] ${m}`));

	if (isWecomPushServerRunning(root)) {
		if (isWecomWsReady(root)) {
			return 'queue';
		}
		log('本地 server 在运行但 WebSocket 未连接，安排重启…');
		scheduleWecomServiceRestart(root, '推送前 WebSocket 未就绪');
		await waitForLocalWecomWs(root, opts);
		return 'queue';
	}

	await probeWecomWebSocket(env);
	return 'direct';
}

/**
 * 推送/任务触发前：检查 WebSocket，失败则重连/重启；最多 3 次，间隔 5 分钟。
 */
export async function ensureWecomPushReady(
	root: string,
	env: Record<string, string>,
	opts: WecomPushGuardOpts = {},
): Promise<WecomPushMode> {
	const maxAttempts = opts.maxAttempts ?? WECOM_PUSH_MAX_ATTEMPTS;
	const retryIntervalMs = opts.retryIntervalMs ?? WECOM_PUSH_RETRY_MS;
	const log = opts.log ?? ((m) => console.log(`[wecom-guard] ${m}`));

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const mode = await ensureOnce(root, env, opts);
			log(`第 ${attempt}/${maxAttempts} 次检查通过，模式=${mode}`);
			return mode;
		} catch (err) {
			lastError = err;
			const msg = err instanceof Error ? err.message : String(err);
			if (attempt >= maxAttempts) break;
			log(`第 ${attempt}/${maxAttempts} 次失败: ${msg}，${Math.round(retryIntervalMs / 60000)} 分钟后重试…`);
			await sleep(retryIntervalMs);
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 包装推送操作：先 ensure，再执行；推送失败同样 3×5min 重试 */
export async function runWithWecomPushGuard<T>(
	root: string,
	env: Record<string, string>,
	fn: (mode: WecomPushMode) => Promise<T>,
	opts: WecomPushGuardOpts & { label?: string } = {},
): Promise<T> {
	const maxAttempts = opts.maxAttempts ?? WECOM_PUSH_MAX_ATTEMPTS;
	const retryIntervalMs = opts.retryIntervalMs ?? WECOM_PUSH_RETRY_MS;
	const log = opts.log ?? ((m) => console.log(`[wecom-guard] ${m}`));
	const label = opts.label ?? '推送';

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const mode = await ensureWecomPushReady(root, env, { ...opts, maxAttempts: 1 });
			return await fn(mode);
		} catch (err) {
			lastError = err;
			const msg = err instanceof Error ? err.message : String(err);
			if (attempt >= maxAttempts) break;
			log(`${label} 第 ${attempt}/${maxAttempts} 次失败: ${msg}，${Math.round(retryIntervalMs / 60000)} 分钟后重试…`);
			await sleep(retryIntervalMs);
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
