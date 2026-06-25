/**
 * 手动触发企业微信定时任务（与 wecom/server.ts 调度器行为一致）
 * 用法: bun run scripts/run-wecom-cron-now.ts [job-id-prefix] [chatid]
 */
import AiBot from '@wecom/aibot-node-sdk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type CronJob, type CronStoreFile } from '../shared/scheduler.ts';
import { AgentExecutor } from '../shared/agent-executor.ts';
import { getDefaultModel } from '../shared/models-config.js';
import {
	enqueueWecomPush,
	isWecomPushServerRunning,
} from '../shared/wecom-push-queue.ts';
import { ensureWecomPushReady } from '../shared/wecom-push-guard.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(ROOT, 'wecom/.env');
const CRON_PATH = resolve(ROOT, 'cron-jobs-wecom.json');
const jobPrefix = process.argv[2] || 'daily-email-digest';
const chatidOverride = process.argv[3];

function loadEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const [key, ...vals] = trimmed.split('=');
		if (!key) continue;
		let val = vals.join('=').trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[key.trim()] = val;
	}
	return env;
}

function loadJob(prefix: string): CronJob {
	const store = JSON.parse(readFileSync(CRON_PATH, 'utf-8')) as CronStoreFile;
	const job = store.jobs.find((j) => j.id.startsWith(prefix) || j.name.includes(prefix));
	if (!job) throw new Error(`未找到任务: ${prefix}`);
	return job;
}

async function pushViaWebSocket(
	env: Record<string, string>,
	chatid: string,
	title: string,
	body: string,
): Promise<void> {
	const wsClient = new AiBot.WSClient({
		botId: env.WECOM_BOT_ID!,
		secret: env.WECOM_BOT_SECRET!,
	});

	await new Promise<void>((resolveConnect, reject) => {
		const timeout = setTimeout(() => reject(new Error('企业微信连接超时')), 15000);
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

	try {
		await wsClient.sendMessage(chatid, {
			msgtype: 'markdown',
			markdown: { content: `**${title}**\n\n${body.slice(0, 3000)}` },
		});
	} finally {
		wsClient.disconnect();
	}
}

async function deliver(
	chatid: string,
	title: string,
	body: string,
	env: Record<string, string>,
): Promise<void> {
	if (isWecomPushServerRunning(ROOT)) {
		enqueueWecomPush(ROOT, { chatid, title, body });
		console.log(`[run-cron] 已写入推送队列 → ${chatid}（由 wecom/server 发送）`);
		return;
	}
	await pushViaWebSocket(env, chatid, title, body);
}

async function main() {
	if (!existsSync(ENV_PATH)) throw new Error(`缺少 ${ENV_PATH}`);
	if (!existsSync(CRON_PATH)) throw new Error(`缺少 ${CRON_PATH}`);

	const env = loadEnv();
	const job = loadJob(jobPrefix);
	const chatid = chatidOverride || job.webhook || 'LiuHaoCheng';

	if (job.task?.type !== 'agent-prompt') {
		throw new Error(`任务 ${job.id} 不是 agent-prompt 类型`);
	}

	await ensureWecomPushReady(ROOT, env, { log: (m) => console.log(`[run-cron] ${m}`) });

	await deliver(chatid, '手动执行中', `正在运行: **${job.name}**…`, env);

	const agentExecutor = new AgentExecutor({ timeout: job.task.options?.timeoutMs ?? 600_000 });
	const workspace = job.workspace || ROOT;
	const model = job.model || env.CURSOR_MODEL || getDefaultModel();

	console.log(`[run-cron] job=${job.id} workspace=${workspace} model=${model}`);

	const { result } = await agentExecutor.execute({
		workspace,
		model,
		prompt: job.task.prompt,
		platform: 'wecom',
		webhook: chatid,
		apiKey: env.CURSOR_API_KEY || undefined,
	});

	await deliver(chatid, `定时任务：${job.name}`, result.trim(), env);
	console.log(`[run-cron] 完成，已推送至 ${chatid}`);
	process.exit(0);
}

main().catch((err) => {
	console.error('[run-cron] 失败:', err);
	process.exit(1);
});
