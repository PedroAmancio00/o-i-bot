import { Devvit, Scheduler, TriggerContext } from '@devvit/public-api';
import { countVotesJob, getAllRedisData, onCommentCreate, onPostCreate, reagendarJobs } from './service.js';

Devvit.configure({
	redditAPI: true,
	redis: true,
});

Devvit.addSchedulerJob({
	name: 'countVotes',
	onRun: async (_, context) => {
		countVotesJob(context);
	},
});

// Trigger para quando o app é atualizado
Devvit.addTrigger({
	event: 'AppUpgrade',
	onEvent: async (_, context) => {
		console.log('App upgraded!');
		reagendarJobs(context);
		countVotesJob(context);
	},
});

// Trigger para registrar o voto
Devvit.addTrigger({
	event: 'CommentCreate',
	onEvent: onCommentCreate,
});

// Trigger para registrar uma chave no Redis quando um post é criado
Devvit.addTrigger({
	event: 'PostCreate',
	onEvent: onPostCreate,
});

Devvit.addMenuItem({
	location: 'subreddit',
	label: 'See Redis',
	onPress: async (event, context) => {
		if (!event) return;
		getAllRedisData(context);
	},
});

export default Devvit;
