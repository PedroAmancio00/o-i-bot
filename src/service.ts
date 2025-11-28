import { Devvit, TriggerContext, PostCreateDefinition, TriggerOnEventHandler } from '@devvit/public-api';
import type { CommentCreate, PostCreate } from '@devvit/protos/types/devvit/events/v1alpha/events.d.ts';
import { TimeToCheck } from './constants/contants.js';

export const registerKey = async (context: TriggerContext, key: string) => {
	await context.redis.hSet('index:keys', { [key]: 'active' }); // Marca como ativa
	console.log(`Chave registrada: ${key}`);
};

export const getAllRedisData = async (context: Devvit.Context) => {
	const subredditName = context.subredditName;
	const { redis } = context;
	if (subredditName === undefined) {
		context.ui.showToast('Este menu item só pode ser usado dentro de um subreddit.');
		return;
	}
	const dump: Record<string, any> = {};
	let allKeys: string[] = [];

	// 1. Tente pegar chaves de um hash índice (crie no seu app: hSet('index:keys', { 'chave1': '1' }))
	try {
		allKeys = await redis.hKeys('index:keys');
	} catch (e) {
		console.warn('Sem hash índice? Adicionando chaves hardcoded. Erro:', e);
	}

	if (allKeys.length === 0) {
		context.ui.showToast('Nenhuma chave encontrada! Crie um hash índice primeiro.');
		return;
	}

	let allValues: string[] = [];

	try {
		allValues = (await redis.mGet(allKeys)).toString().split(',');
	} catch (e) {
		console.error('Erro ao buscar valores das chaves:', e);
		context.ui.showToast('Erro ao buscar valores das chaves. Veja o console para mais detalhes.');
		return;
	}
	console.log(`Encontradas ${allValues} chaves no índice.`);

	// 4. Poste o dump como JSON no sub
	try {
		console.log('=== REDIS DUMP COMPLETO ===');
		console.log('Subreddit:', context.subredditName);
		console.log('Data:', new Date().toISOString());
		console.log('Total de chaves processadas:', Object.keys(dump).length);
		console.log('Conteúdo:');
		console.log(JSON.stringify(dump, null, 2));
		console.log('=== FIM DO DUMP ===');

		context.ui.showToast(`Dump enviado pros logs! (${Object.keys(dump).length} itens)`);
	} catch (postError) {
		console.error('Erro ao postar:', postError);
		context.ui.showToast('Dump salvo no console. Copie de lá!');
		console.log('DUMP COMPLETO:', JSON.stringify(dump, null, 2));
	}
};

export const onPostCreate = async (event: PostCreate, context: TriggerContext) => {
	const { post } = event;

	// Se não encontrar o post, sai
	if (!post) return;

	//Cria a data para checagem futura
	const date = new Date();
	console.log(
		`Novo post criado com o título: ${post.title}, id: ${post.id}, data: ${date.toLocaleString('pt-BR', {
			timeZone: 'America/Sao_Paulo',
		})}`
	);
	date.setDate(date.getDate() + TimeToCheck);

	const comment = await context.reddit.submitComment({
		id: post.id,
		text: `
Que comecem os votos! Use os seguintes marcadores nos comentários para votar:
- Opinião Impopular (O/I): 0
- Opinião Popular (O/P): 0
- Opinião Específica (O/E): 0
- Votos Totais: 0

- Resultado: (Aguardando votos)

Os resultados atualizam a cada hora`,
	});

	await comment.distinguish(true);

	// Inicializa os votos
	const votes: Votes = {
		opiniaoImpopular: 0,
		opiniaoPopular: 0,
		opiniaoEspecifica: 0,
		total: 0,
		checkDate: date,
		commentId: comment.id,
	};
	const key = post.id;
	// Registra o post no Redis com a data para checagem futura
	await context.redis.set(key, JSON.stringify(votes));
	await registerKey(context, key);
};

const determineVote = (votes: Votes, comment: string) => {
	// Mapeia cada marcador para o campo correspondente
	const matchers: Record<string, keyof Votes> = {
		'O/I': 'opiniaoImpopular',
		'O/P': 'opiniaoPopular',
		'O/E': 'opiniaoEspecifica',
	};

	// Encontra quais marcadores aparecem no comentário
	const found = Object.entries(matchers).filter(([key]) => comment.includes(key));

	// Se encontrou mais de 1, invalida o voto
	if (found.length !== 1) {
		return;
	}

	// Pega o único marcador válido
	const [, voteKey] = found[0];

	// Incrementa votos
	const current = (votes as any)[voteKey];
	if (typeof current !== 'number') {
		return;
	}
	(votes as any)[voteKey] = current + 1;
	votes.total += 1;
};

export const onCommentCreate = async (event: CommentCreate, context: TriggerContext) => {
	const { comment } = event;
	const { reddit, redis } = context;

	// Verifica se o comentário é uma resposta a um post
	if (!comment || !comment?.parentId?.startsWith('t3_') || !reddit || !redis) return;

	const post = await reddit.getPostById(comment.parentId);
	// Se não encontrar o post, sai
	if (!post) return;

	// Verifica se o post foi criado há mais de {TimeToCheck} dias
	const postDateToCheck = new Date(post.createdAt);
	postDateToCheck.setDate(postDateToCheck.getDate() + TimeToCheck);
	const removed = post.removed;
	const commentCreatedAt = new Date(comment.createdAt);
	// Se o post foi removido ou o comentário foi criado após o período de verificação, sai
	if (removed || commentCreatedAt >= postDateToCheck) {
		console.log(
			`Comentário criado após o período de verificação, ou post removido. Ignorando. Comentário ID: ${comment.id}`
		);
		return;
	}
	const now = new Date();
	console.log(
		`Registrando voto do comentário ID: ${comment.id} para o post ID: ${post.id}, data atual: ${now.toLocaleString(
			'pt-BR',
			{ timeZone: 'America/Sao_Paulo' }
		)}`
	);
	const key = post.id;
	try {
		const votesData = await redis.get(key);
		if (!votesData) {
			console.log(`Nenhum dado de votos encontrado para o post ID: ${post.id}`);
			return;
		}
		const votes: Votes = JSON.parse(votesData);
		determineVote(votes, comment.body);
		const text = await countVote(votes);
		const fixedComment = await reddit.getCommentById(votes.commentId);
		if (fixedComment) {
			await fixedComment.edit({ text });
			console.log(`Comentário atualizado para a chave: ${key}`);
		} else {
			console.log(`Comentário não encontrado para a chave: ${key}`);
		}
		await redis.set(key, JSON.stringify(votes));
	} catch (error) {
		console.error(`Erro ao processar votos para a chave: ${key}`, error);
	}
};

const determineResult = (votes: Votes): string => {
	const entries = Object.entries(votes);
	const sorted = entries.sort((a, b) => b[1] - a[1]); // maior → menor

	const [topKey, topValue] = sorted[0];
	const [, secondValue] = sorted[1];

	// empates
	if (topValue === secondValue) {
		return 'Empate entre as opiniões!';
	}

	const labels: Record<string, string> = {
		opiniaoImpopular: 'Opinião Impopular venceu!',
		opiniaoPopular: 'Opinião Popular venceu!',
		opiniaoEspecifica: 'Opinião Específica venceu!',
	};

	return labels[topKey] ?? 'Resultado desconhecido';
};

const determineParcialResult = (votes: Votes): string => {
	const entries = Object.entries(votes).filter(
		([key]) => key !== 'total' && key !== 'checkDate' && key !== 'commentId'
	);
	const sorted = entries.sort((a, b) => b[1] - a[1]); // maior → menor

	const [topKey, topValue] = sorted[0];
	const [, secondValue] = sorted[1];

	// empates
	if (topValue === secondValue) {
		return 'Empate entre as opiniões!';
	}

	const labels: Record<string, string> = {
		opiniaoImpopular: 'Opinião Impopular está vencendo!',
		opiniaoPopular: 'Opinião Popular está vencendo!',
		opiniaoEspecifica: 'Opinião Específica está vencendo!',
	};

	return labels[topKey] ?? 'Resultado desconhecido';
};

async function clearJobs(context: TriggerContext) {
	const jobs = await context.scheduler.listJobs();
	console.log(`Jobs encontrados: ${jobs.length}`);
	for (const job of jobs) {
		console.log(`Cancelando: (${job.name})`);
		await context.scheduler.cancelJob(job.id);
	}
}

export async function reagendarJobs(context: TriggerContext) {
	console.log('Cancelando jobs antigos...');
	try {
		await clearJobs(context);
	} catch (err: any) {
		console.error('Erro ao listar/cancelar jobs:', err.message);
	}

	// console.log('Agendando countVotes a cada 1 hora...');
	// try {
	// 	await context.scheduler.runJob({
	// 		name: 'countVotes',
	// 		cron: '0 * * * *', // a cada hora cheia
	// 		// cron: '*/1 * * * *' // pra teste a cada 1 min
	// 	});
	// 	console.log('Job countVotes agendado com sucesso!');
	// } catch (err: any) {
	// 	console.error('Erro ao agendar:', err.message);
	// }
}

async function countVote(votes: Votes) {
	const result = determineParcialResult(votes);
	return `
Que comecem os votos! Use os seguintes marcadores nos comentários para votar:

- Opinião Impopular (O/I): ${votes.opiniaoImpopular}
- Opinião Popular (O/P): ${votes.opiniaoPopular}
- Opinião Específica (O/E): ${votes.opiniaoEspecifica}
- Votos Totais: ${votes.total}

- Resultado: ${result}`;
}

export async function countVotesJob(context: TriggerContext) {
	const { redis, reddit } = context;
	if (!redis || !reddit) {
		console.error('Redis ou Reddit API não estão disponíveis no contexto.');
		return;
	}

	let allKeys: string[] = [];

	// 1. Tente pegar chaves de um hash índice (crie no seu app: hSet('index:keys', { 'chave1': '1' }))
	try {
		allKeys = await redis.hKeys('index:keys');
	} catch (e) {
		console.warn('Sem hash índice? Adicionando chaves hardcoded. Erro:', e);
	}
	if (allKeys.length === 0) {
		console.log('Nenhuma chave encontrada! Crie um hash índice primeiro.');
		return;
	}
	for (const key of allKeys) {
		try {
			const votesData = await redis.get(key);
			if (!votesData) {
				console.log(`Nenhum dado de votos encontrado para a chave: ${key}`);
				continue;
			}
			const votes: Votes = JSON.parse(votesData);

			const text = await countVote(votes);

			const comment = await reddit.getCommentById(votes.commentId);
			if (comment) {
				await comment.edit({ text });
				console.log(`Comentário atualizado para a chave: ${key}`);
			} else {
				console.log(`Comentário não encontrado para a chave: ${key}`);
			}
		} catch (err) {
			console.error(`Erro ao processar a chave ${key}:`, err);
		}
	}
}
