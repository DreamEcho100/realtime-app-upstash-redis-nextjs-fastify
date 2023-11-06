import closeWithGrace from 'close-with-grace';
import dotenv from 'dotenv';
dotenv.config();

import { z } from 'zod';
import fastify from 'fastify';
import fastifyCors, { FastifyCorsOptions } from '@fastify/cors';
import fastifySocketIO from 'fastify-socket.io';
import { Server } from 'socket.io';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

declare module 'fastify' {
	export interface FastifyInstance {
		io: Server;
	}
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const HOST = process.env.HOST ?? '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;

const CONNECTION_COUNT_KEY = 'chat:connection-count';
const CONNECTION_COUNT_UPDATED_CHANNEL = 'chat:connection-count-updated';
const NEW_MESSAGE_CHANNEL = 'chat:new-message';

if (!UPSTASH_REDIS_REST_URL) {
	console.error('missing UPSTASH_REDIS_REST_URL');
	process.exit(1);
}

const publisher = new Redis.default(UPSTASH_REDIS_REST_URL, {
	// tls: { rejectUnauthorized: true }
});
const subscriber = new Redis.default(UPSTASH_REDIS_REST_URL, {
	// tls: { rejectUnauthorized: true }
});

function buildServer() {
	const app = fastify({ logger: { transport: { target: 'pino-pretty' } } });

	return app;
}

let connectedClients = 0;

try {
	const app = await buildServer();

	closeWithGrace({ delay: 2000 }, async (opt) => {
		console.log(opt);
		app.log.info('Shutting down');

		if (connectedClients > 0) {
			app.log.info(
				`Removing ${connectedClients} from the count of connected clients`
			);

			const publisherCONNECTION_COUNT_KEY = await publisher.get(
				CONNECTION_COUNT_KEY
			);
			const currentCount = publisherCONNECTION_COUNT_KEY
				? parseInt(publisherCONNECTION_COUNT_KEY, 10)
				: 0;

			const newCount = Math.max(currentCount - connectedClients, 0);

			await publisher.set(CONNECTION_COUNT_UPDATED_CHANNEL, newCount);
		}

		app.log.info('Shutdown complete');
		await app.close();
		console.log('See you later');
	});

	async function publishToCONNECTION_COUNT_UPDATED_CHANNEL(newCount: number) {
		await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, String(newCount));
	}

	subscriber.subscribe(CONNECTION_COUNT_UPDATED_CHANNEL, (err, count) => {
		if (err) {
			app.log.error(`Error subscribing to ${CONNECTION_COUNT_UPDATED_CHANNEL}`);
			return;
		}

		app.log.info(
			`${count} clients subscribed to \`${CONNECTION_COUNT_UPDATED_CHANNEL}\` channel`
		);
	});
	subscriber.subscribe(NEW_MESSAGE_CHANNEL, (err, count) => {
		if (err) {
			app.log.error(`Error subscribing to ${NEW_MESSAGE_CHANNEL}`);
			return;
		}

		app.log.info(
			`${count} clients subscribed to \`${NEW_MESSAGE_CHANNEL}\` channel`
		);
	});

	subscriber.on('message', (channel, text) => {
		switch (channel) {
			case CONNECTION_COUNT_UPDATED_CHANNEL:
				app.io.emit(CONNECTION_COUNT_UPDATED_CHANNEL, { count: text });
				break;
			case NEW_MESSAGE_CHANNEL:
				app.io.emit(NEW_MESSAGE_CHANNEL, {
					id: randomUUID(),
					message: text,
					createdAt: new Date(),
					port: PORT
				});
				break;

			default:
				break;
		}
	});

	const currentCount =
		(await publisher.get(CONNECTION_COUNT_KEY)) ??
		(await publisher.set(CONNECTION_COUNT_KEY, 0, 'GET'));

	app.log.info(
		`redis: currentCount: ${currentCount}, type: ${typeof currentCount}`
	);

	const corsOptions = {
		origin: [
			CORS_ORIGIN
			// 'https://stackoverflow.com'
		],
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
		credentials: false,
		allowedHeaders: ['Content-Type', 'Authorization']
	} satisfies FastifyCorsOptions;

	await app.register(fastifyCors, corsOptions);
	await app.register(fastifySocketIO.default, { cors: corsOptions });

	app.io.on('connection', async (io) => {
		await publishToCONNECTION_COUNT_UPDATED_CHANNEL(
			await publisher.incr(CONNECTION_COUNT_KEY)
		);
		connectedClients++;
		app.log.info('io: Client connected');

		io.on('disconnect', async () => {
			await publishToCONNECTION_COUNT_UPDATED_CHANNEL(
				await publisher.decr(CONNECTION_COUNT_KEY)
			);
			connectedClients--;
			app.log.info('io: Client disconnected');
		});

		io.on(NEW_MESSAGE_CHANNEL, (params) => {
			const input = z.object({ message: z.string() }).safeParse(params);

			if (input.success)
				publisher.publish(NEW_MESSAGE_CHANNEL, input.data.message.toString());
		});
	});

	app.get('/health-check', () => {
		return {
			status: 'ok',
			port: PORT
		};
	});

	app.listen({ port: PORT, host: HOST }, (err) => {
		if (err) {
			throw new Error(err.message);
		}

		app.log.info(`Server is running at http://localhost:${PORT}`);
	});
} catch (err) {
	console.error((err instanceof Error && err.message) || String(err));
	process.exit(1);
}
