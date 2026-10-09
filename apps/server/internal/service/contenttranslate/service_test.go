package contenttranslate

import (
	"context"
	"testing"

	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/stretchr/testify/require"
)

type fakeTranslator struct {
	Calls  int
	Inputs []llm.ContentInput
	Run    func(llm.ContentInput) (llm.ContentOutput, error)
}

func (f *fakeTranslator) TranslateContent(_ context.Context, in llm.ContentInput) (llm.ContentOutput, llm.Usage, error) {
	f.Calls++
	f.Inputs = append(f.Inputs, in)
	out, err := f.Run(in)
	return out, llm.Usage{Attempts: []llm.Attempt{{Model: "fake", FinishReason: "stop", PromptTokens: 10, CompletionTokens: 5}}}, err
}
func TestValidationRetriesOnceWithStrictPrompt(t *testing.T) {
	fake := &fakeTranslator{}
	fake.Run = func(in llm.ContentInput) (llm.ContentOutput, error) {
		if !in.Strict {
			return llm.ContentOutput{"ja-JP": {"text": "The application manages files"}}, nil
		}
		return llm.ContentOutput{"ja-JP": {"text": "ファイルを管理するアプリです"}}, nil
	}
	svc := Service{LLM: fake}
	in := llm.ContentInput{SourceLocale: "zh-CN", Targets: []string{"ja-JP"}, Fields: map[string]string{"text": "管理文件的应用"}}
	_, usage, err := svc.call(context.Background(), in)
	require.NoError(t, err)
	require.Equal(t, 2, fake.Calls)
	require.EqualValues(t, 30, usage.Tokens())
	require.True(t, fake.Inputs[1].Strict)
	fake.Calls = 0
	svc.NoRetry = true
	_, _, err = svc.call(context.Background(), in)
	require.Error(t, err)
	require.Equal(t, 1, fake.Calls)
	fake.Calls = 0
	svc.NoRetry = false
	fake.Run = func(llm.ContentInput) (llm.ContentOutput, error) { return nil, &llm.Failure{Reason: "wrong_language"} }
	_, _, err = svc.call(context.Background(), in)
	require.Error(t, err)
	require.Equal(t, 2, fake.Calls)
}
func TestPlanBatchesShortAndSplitsLongByTarget(t *testing.T) {
	in := llm.ContentInput{Targets: []string{"zh-CN", "ja-JP"}, Fields: map[string]string{"title": "Title", "body": "Paragraph\n\n```sh\necho value\n\n echo next\n```"}}
	plan := Plan(in, map[string]bool{"body": true})
	require.Len(t, plan, 3)
	require.Len(t, plan[0].Targets, 2)
	require.Equal(t, map[string]string{"title": "Title"}, plan[0].Fields)
	require.Len(t, plan[1].Targets, 1)
	require.Equal(t, in.Fields["body"], plan[1].Fields["body"])
	parts := chunks(in.Fields["body"], 15)
	require.Len(t, parts, 2)
	require.Contains(t, parts[1], "echo value\n\n echo next")
}

func TestNetworkRetriesAreBounded(t *testing.T) {
	fake := &fakeTranslator{Run: func(llm.ContentInput) (llm.ContentOutput, error) {
		return nil, &llm.Failure{Reason: "transport", Retryable: true}
	}}
	svc := Service{LLM: fake}
	_, usage, err := svc.call(context.Background(), llm.ContentInput{})
	require.Error(t, err)
	require.Equal(t, 4, fake.Calls)
	require.Len(t, usage.Attempts, 4)
}
