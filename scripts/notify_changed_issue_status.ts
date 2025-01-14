import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config(); // ローカル確認用

const TOKEN: string = process.env.GITHUB_TOKEN || '';
const ORG = process.env.ORG || '';
const PROJECT_NUM = process.env.PROJECT_NUM || '';
const PROJECT_KEY: string = `${ORG}/${PROJECT_NUM}`;
const REPO = process.env.REPO || '';
const STATE_FILE: string = 'data/state.json';
const SLACK_WEBHOOK_URL: string = process.env.SLACK_WEBHOOK_URL || '';
const NOTIFY_USERS: string = process.env.NOTIFY_USERS || '';

if (!TOKEN) {
  throw new Error('GITHUB_TOKEN is not set. Please set it in the environment variables.');
}

type Result = {
  title: string;
  number: number;
  updatedAt: string;
}

type Results = {
  DevelopmentPendingFrontend: Result[];
  QATesting: Result[];
  Unset: Result[];
}
// フィールドの型定義
type FieldValueNode = {
  field: {
    name: string;
  };
  name: string;
}

type IssueNode = {
  __typename: 'Issue';
  id: string;
  number: number;
  title: string;
  updatedAt: string;
  projectItems: {
    nodes: {
      fieldValues: {
        nodes: FieldValueNode[];
      };
    }[];
  };
}

type SearchNode = IssueNode; // 他にも PullRequest などを追加する場合は union 型にする

type GraphQLResponse = {
  data: {
    search: {
      nodes: SearchNode[];
    };
  };
}

type GraphQLErrorResponse = {
  errors: Record<string, any>;
}

enum Status {
  DevelopmentPendingFrontend = '開発待ち(Frontend)',
  QATesting = 'QA中',
  Unset = '未設定'
}

const readStateFile = (): Results => {
  try {
    const fileContent = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsedContent = JSON.parse(fileContent);
    console.log('stateFile:', parsedContent);

    return {
      DevelopmentPendingFrontend: parsedContent.DevelopmentPendingFrontend || [],
      QATesting: parsedContent.QATesting || [],
      Unset: parsedContent.Unset || []
    };
  } catch (error) {
    console.error('Error reading or parsing state file:', error);

    // ファイルが存在しない場合は空のデータを返す
    return {
      DevelopmentPendingFrontend: [],
      QATesting: [],
      Unset: []
    };
  }
}

// STATE_FILEからデータ取得
const oldState: Results = readStateFile();

const getNewState = (): Promise<Results> => {
  const buildLimitDate = (): string => {
    const date = new Date();
    date.setMonth(date.getMonth() - 6);
    return date.toISOString().split('T')[0];
  }
  const isoLimitDate = buildLimitDate();

  // GraphQL クエリを定義
  const query: string = `
    query {
      search(query: "is:open is:issue project:${PROJECT_KEY} updated:>=${isoLimitDate}", type: ISSUE, first: 100) {
        nodes {
          __typename
          ... on Issue {
            id
            number
            title
            updatedAt
            projectItems(first: 10) {
              nodes {
                fieldValues(first: 10) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      field {
                        ... on ProjectV2SingleSelectField {
                          name
                        }
                      }
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  // API リクエストを送信してデータを取得
  const fetchProjectData = async (): Promise<Results> => {
    const isGraphQLErrorResponse = (data: any): data is GraphQLErrorResponse => {
      return 'errors' in data;
    };

    const toJapaneseDate = (date: string): string => {
      return new Date(date).toLocaleString('ja-JP');
    }

    const results: Results = {
      DevelopmentPendingFrontend: [],
      QATesting: [],
      Unset: []
    }
    try {
      const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log(data);
      // エラーレスポンスかどうかをチェック
      if (isGraphQLErrorResponse(data)) {
        console.error('GraphQL Errors:', data.errors);
        throw new Error('GraphQL Error');
      }
      const items: SearchNode[] = (data as GraphQLResponse).data.search.nodes;

      // タイトルとステータスを一覧化して表示
      items.forEach((item) => {
        if (item.__typename === 'Issue') {
          const title = item.title;
          const statusField = item.projectItems.nodes[0]?.fieldValues.nodes.find(
            (field) => field.field?.name === 'Status'
          );
          const status = statusField ? statusField.name : '未設定';

          if (status === Status.DevelopmentPendingFrontend) {
            results.DevelopmentPendingFrontend.push(
              {
                title: title,
                number: item.number,
                updatedAt: item.updatedAt
              }
            )
            console.log(`Title: ${title}, Status: ${status}, Number: ${item.number}, Updated At: ${toJapaneseDate(item.updatedAt)}`);
          } else if (status === 'QA中') {
            results.QATesting.push(
              {
                title: title,
                number: item.number,
                updatedAt: item.updatedAt
              }
            )
            console.log(`Title: ${title}, Status: ${status}, Number: ${item.number}, Updated At: ${toJapaneseDate(item.updatedAt)}`);
          }
        }
      });
    } catch (error) {
      console.error('Error:', error);
    }
    return results;
  };

  return fetchProjectData();
}

const main = async (): Promise<void> => {
  const newState: Results = await getNewState();

  // oldStateとnewStateを比較し、 newStateに新しく追加されたデータを取得
  const getUpdatedStatusData = (oldState: Results, newState: Results): Results => {
    const newDevelopmentPendingFrontend = newState.DevelopmentPendingFrontend.filter(
      (item) => !oldState.DevelopmentPendingFrontend.some((oldItem) => oldItem.number === item.number)
    );
    const newQATesting = newState.QATesting.filter(
      (item) => !oldState.QATesting.some((oldItem) => oldItem.number === item.number)
    );
    return {
      DevelopmentPendingFrontend: newDevelopmentPendingFrontend,
      QATesting: newQATesting,
      Unset: []
    };
  }

  const updatedStatusData: Results = getUpdatedStatusData(oldState, newState);

  let testCount: number = 0;
  // slack通知
  const postToSlack = async (status: string, issueTitle: string, issueUrl: string): Promise<void> => {
    let message = '';
    let iconEmoji = '';

    if (status === Status.DevelopmentPendingFrontend) {
      message = `Issue status changed to *開発待ち(Frontend)* : ${NOTIFY_USERS} 次のフロント開発準備OK👍 \n*Issue Title:* <${issueUrl}|${issueTitle}>`;
      iconEmoji = ':rocket:';
    } else if (status === Status.QATesting) {
      message = `Issue status changed to *テスト中* : ${NOTIFY_USERS} テストを開始してください🏃‍♂️ \n*Issue Title:* <${issueUrl}|${issueTitle}>`;
      iconEmoji = ':test_tube:';
    }

    try {
      await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: message,
          icon_emoji: iconEmoji,
        }),
      });
      // testCountをインクリメント
      testCount++;
    } catch (error) {
      console.error('Error:', error);
    }
  }

  const buildIssueUrl = (issueNumber: number): string => {
    return `https://github.com/${ORG}/${REPO}/issues/${issueNumber}`;
  }

  // slack通知を送信: DevelopmentPendingFrontend
  updatedStatusData.DevelopmentPendingFrontend.forEach((item) => {
    const issueUrl = buildIssueUrl(item.number);
    postToSlack(Status.DevelopmentPendingFrontend, item.title, issueUrl);
    // 1件のみ通知
    if (testCount >= 1) {
      process.exit(0);
    }
  });

  // slack通知を送信: QATesting
  updatedStatusData.QATesting.forEach((item) => {
    const issueUrl = buildIssueUrl(item.number);
    postToSlack(Status.QATesting, item.title, issueUrl);
    // 1件のみ通知
    if (testCount >= 1) {
      process.exit(0);
    }
  });

  const ensureDirectoryExistence = () => {
    const dirname = path.dirname(STATE_FILE);
    if (fs.existsSync(dirname)) {
      return true;
    }
    fs.mkdirSync(dirname, { recursive: true });
  };

  ensureDirectoryExistence();
  // newStateをファイルに保存
  fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
}

main().catch(console.error);
