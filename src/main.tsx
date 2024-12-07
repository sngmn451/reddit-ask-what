import {
  Devvit,
  JSONObject,
  useChannel,
  useForm,
  useState,
} from "@devvit/public-api";

const appName = "ask_whattt";

interface RealtimeMessage extends JSONObject {
  payload: DataType;
  session: string;
  postId: string;
}
interface DataType extends JSONObject {
  question: string;
  image: string;
  answer: {
    answerId: string;
    userId: string;
    value: string;
    createdAt: number;
  }[];
  ttl: number;
  maxAnswer: number;
  askUserId: string;
  timeout: number;
  voted: {
    userId: string;
    answerId: string;
  }[];
}

Devvit.configure({
  redditAPI: true,
  redis: true,
  media: true,
  realtime: true,
});

Devvit.addMenuItem({
  label: "Ask question",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_event, context) => {
    const { ui } = context;
    ui.showForm(askForm);
  },
});

const askForm = Devvit.createForm(
  {
    fields: [
      {
        type: "string",
        name: "question",
        label: "Question",
        required: true,
      },
      {
        type: "image",
        name: "image",
        label: "Image",
        required: true,
      },
      {
        type: "select",
        name: "ttl",
        label: "Accept answer until",
        multiSelect: false,
        required: true,
        defaultValue: ["24"],
        options: [
          {
            value: "1",
            label: "1 Hour",
          },
          {
            value: "4",
            label: "4 Hours",
          },
          {
            value: "12",
            label: "12 Hours",
          },
          {
            value: "24",
            label: "1 Day",
          },
        ],
      },
      {
        type: "select",
        name: "maxAnswer",
        label: "Max answers",
        multiSelect: false,
        required: true,
        defaultValue: ["3"],
        options: [
          {
            value: "3",
            label: "3",
          },
          {
            value: "4",
            label: "4",
          },
          {
            value: "5",
            label: "5",
          },
          {
            value: "6",
            label: "6",
          },
        ],
      },
    ],
  },
  async (event, context) => {
    const { media, redis, userId, reddit, ui } = context;
    const { values } = event;

    ui.showToast("Creating..");
    const subreddit = await reddit.getCurrentSubreddit();
    const post = await reddit.submitPost({
      title: "Ask what!?",
      subredditName: subreddit.name,

      preview: (
        <vstack height="100%" width="100%" alignment="middle center">
          <text size="large">Loading question...</text>
        </vstack>
      ),
    });
    ui.showToast("Processing image..");
    await media.upload({
      type: "image",
      url: values.image,
    });

    const maxAnswer = Number(values.maxAnswer[0]);
    const ttl = Number(values.ttl[0]);

    ui.showToast("Setting up question..");
    await redis.set(
      post.id,
      JSON.stringify({
        question: values.question,
        image: values.image,
        ttl,
        maxAnswer,
        askUserId: userId ?? "",
        answer: [],
        voted: [],
        timeout: Date.now() + ttl * 60 * 60 * 1000,
      } as DataType)
    );

    ui.showToast({
      text: "Asked! Refresh to see your question",
      appearance: "success",
    });
  }
);

Devvit.addCustomPostType({
  name: "Ask Wattt",
  height: "tall",
  render: (context) => {
    const { redis, userId, postId, ui } = context;
    const [data, setData] = useState<DataType>(async () => {
      return await refetch(false);
    });

    const session = sessionId();
    const channel = useChannel<RealtimeMessage>({
      name: appName,
      onMessage(msg) {
        if (msg.postId === postId) {
          setData(msg.payload);
        }
      },
    });
    channel.subscribe();
    async function refetch(updateState?: boolean) {
      const body = await redis.get(postId!);
      const payload = JSON.parse(body!) as DataType;
      if (updateState) {
        setData(payload);
      }
      return payload;
    }

    const voted = data.voted;
    const votedResult =
      voted && voted.length > 0
        ? voted.reduce((acc, vr) => {
            acc[vr.answerId] = (acc[vr.answerId] || 0) + 1;
            return acc;
          }, {} as Record<string, number>)
        : undefined;
    const answers = data.answer.sort((ans1, ans2) => {
      const ans1Votes = votedResult ? votedResult[ans1.answerId] ?? 0 : 0;
      const ans2Votes = votedResult ? votedResult[ans2.answerId] ?? 0 : 0;
      return ans2Votes - ans1Votes;
    });
    const userAnswer =
      data.voted && data.voted.find((v) => v.userId === userId);
    const maxAnswer = data.maxAnswer;

    const totalVoted = (voted && voted.length) ?? 0;

    const addAnswerForm = useForm(
      {
        fields: [
          {
            type: "string",
            name: "answer",
            label: "Answer",
            required: true,
          },
        ],
      },
      async (values) => {
        const answerId = randomID();
        const id = postId!;

        const existingQuestion = JSON.parse((await redis.get(id))!) as DataType;
        const maxAnswer = existingQuestion.maxAnswer;
        if (existingQuestion.answer.length < maxAnswer) {
          ui.showToast("Answering..");
          const payload: DataType = {
            ...existingQuestion,
            answer: [
              ...existingQuestion.answer,
              {
                answerId,
                userId: userId!,
                value: values.answer,
                createdAt: Date.now(),
              },
            ],
            voted: [
              ...existingQuestion.voted,
              {
                answerId,
                userId: userId!,
              },
            ],
          };
          await redis.set(id, JSON.stringify(payload));
          channel.send({
            session,
            payload,
            postId: postId!,
          });
          await refetch(true);
          ui.showToast("Answered!");
        } else {
          ui.showToast(`Questioner allowed up to ${maxAnswer} answer`);
        }
      }
    );

    const winningOption: string[] = [];
    if (votedResult) {
      const entries = Object.entries(votedResult);
      entries.sort((a, b) => b[1] - a[1]);
      winningOption.push(entries[0][0]);
    }

    async function vote(answerId: string) {
      if (data.timeout < Date.now()) {
        ui.showToast("Poll ended");
        return;
      } else if (userAnswer) {
        ui.showToast("Only 1 voted for one user");
      } else {
        const data = JSON.parse((await redis.get(postId!))!) as DataType;
        const payload: DataType = {
          ...data,
          voted: [
            ...data.voted,
            {
              answerId,
              userId: userId!,
            },
          ],
        };
        await redis.set(postId!, JSON.stringify(payload));
        channel.send({
          session,
          payload,
          postId: postId!,
        });
        ui.showToast({
          text: "Voted!",
          appearance: "success",
        });
      }
    }

    return (
      <vstack height="100%" width="100%" gap="medium" alignment="center middle">
        <vstack width={"90%"}>
          <image
            url={data.image}
            description="Asked Image"
            imageHeight={256}
            imageWidth={256}
            resizeMode="fit"
          />
        </vstack>
        <vstack width={"90%"} gap="medium">
          <text style="heading" size="xxlarge">
            {data.question}?
          </text>
          <vstack gap="small" width={"100%"}>
            {answers.length > 0 &&
              answers.map((answer) => {
                const percentage = votedResult
                  ? Math.floor(
                      ((votedResult[answer.answerId] / totalVoted) * 10000) /
                        100
                    )
                  : 0;
                return (
                  <hstack
                    key={answer.answerId}
                    gap="small"
                    alignment="middle start"
                  >
                    <text>{percentage}%</text>
                    <button
                      size="small"
                      minWidth={`${percentage}%`}
                      appearance={
                        userAnswer?.answerId === answer.answerId
                          ? "primary"
                          : "bordered"
                      }
                      onPress={() => vote(answer.answerId)}
                    >
                      {answer.value}
                    </button>
                    {userAnswer?.answerId === answer.answerId ? (
                      <text>(You)</text>
                    ) : null}
                  </hstack>
                );
              })}
          </vstack>
          {answers.length < maxAnswer && !userAnswer && (
            <button
              onPress={() => {
                ui.showForm(addAnswerForm);
              }}
            >
              New answer
            </button>
          )}
          <text size="xsmall">
            {Intl.NumberFormat().format(totalVoted)} votes
          </text>
        </vstack>
      </vstack>
    );
  },
});

function sessionId(): string {
  let id = "";
  const asciiZero = "0".charCodeAt(0);
  for (let i = 0; i < 4; i++) {
    id += String.fromCharCode(Math.floor(Math.random() * 26) + asciiZero);
  }
  return id;
}
function randomID(): string {
  return `${String(Math.floor(Math.random() * 1000000000000)).padStart(
    8,
    "0"
  )}-${String(Math.floor(Math.random() * 1000000000000)).padStart(
    4,
    "0"
  )}-${String(Math.floor(Math.random() * 1000000000000)).padStart(
    6,
    "0"
  )}-${String(Math.floor(Math.random() * 1000000000000)).padStart(
    4,
    "0"
  )}-${String(Math.floor(Math.random() * 1000000000000)).padStart(12, "0")}`;
}

export default Devvit;
