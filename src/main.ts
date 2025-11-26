import { Devvit } from '@devvit/public-api';

Devvit.configure({
	redditAPI: true,
	redis: true,
});

Devvit.addTrigger({
	event: 'CommentCreate', // escuta TODO comentário
	onEvent: async (event, context) => {
		const { comment } = event;
		if (!comment || !comment.parentId?.startsWith('t3_')) return;

		await context.reddit.submitComment({
			id: comment.id,
			text: 'E aí, comentário raiz!',
		});
	},
});

export default Devvit;
