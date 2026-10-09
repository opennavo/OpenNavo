package interfacesync

import (
	"encoding/json"
	"fmt"
	"strings"
)

func Schema(batch Batch) (map[string]any, map[string]map[string]int) {
	properties := map[string]any{}
	counts := map[string]map[string]int{}
	for _, code := range batch.Locales {
		fields := map[string]any{}
		counts[code] = map[string]int{}
		for _, key := range sortedKeys(batch.Source) {
			n := ExpectedForms(batch.Source[key], batch.English[key], code)
			counts[code][key] = n
			field := map[string]any{"type": "string"}
			if strings.Contains(batch.Source[key], "|") || strings.Contains(batch.English[key], "|") {
				field = map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "minItems": n, "maxItems": n}
			}
			fields[key] = field
		}
		properties[code] = map[string]any{"type": "object", "additionalProperties": false, "properties": fields, "required": sortedKeys(batch.Source)}
	}
	return map[string]any{"type": "object", "additionalProperties": false, "properties": properties, "required": batch.Locales}, counts
}

// Decoding preserves correctly typed keys; an error in one key does not discard neighboring translations.
func DecodeOutput(batch Batch, data []byte) (map[string]map[string]string, error) {
	var raw map[string]map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil {
		return nil, Invalid("invalid schema: " + batch.Target + " (invalid JSON)")
	}
	for code, fields := range raw {
		if !contains(batch.Locales, code) {
			return nil, Invalid("invalid schema: " + batch.Target + "/" + code)
		}
		for key := range fields {
			if _, ok := batch.Source[key]; !ok {
				return nil, Invalid("invalid schema: " + batch.Target + "/" + code + "/" + key)
			}
		}
	}
	output := map[string]map[string]string{}
	reasons := []string{}
	for _, code := range batch.Locales {
		output[code] = map[string]string{}
		for _, key := range sortedKeys(batch.Source) {
			value, ok := raw[code][key]
			if !ok {
				reasons = append(reasons, fmt.Sprintf("missing key: %s/%s/%s", batch.Target, code, key))
				continue
			}
			if strings.Contains(batch.Source[key], "|") || strings.Contains(batch.English[key], "|") {
				var forms []string
				n := ExpectedForms(batch.Source[key], batch.English[key], code)
				if json.Unmarshal(value, &forms) != nil || len(forms) != n {
					reasons = append(reasons, fmt.Sprintf("invalid plural: %s/%s/%s expected=%d array forms", batch.Target, code, key, n))
					continue
				}
				output[code][key] = strings.Join(forms, " | ")
			} else {
				var text string
				if string(value) == "null" || json.Unmarshal(value, &text) != nil {
					reasons = append(reasons, fmt.Sprintf("invalid schema: %s/%s/%s expected string", batch.Target, code, key))
					continue
				}
				output[code][key] = text
			}
		}
	}
	if len(reasons) > 0 {
		return output, Invalid(strings.Join(reasons, "; "))
	}
	return output, nil
}
func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
