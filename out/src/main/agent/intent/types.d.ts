export interface IntentResult {
    intent: string;
    slots: Record<string, string>;
}
export interface IntentHandler {
    intent: string;
    description: string;
    execute: (slots: Record<string, string>) => string | Promise<string>;
}
export declare const INTENT_CLASSIFY_PROMPT = "\u4F60\u662F\u4E00\u4E2A\u610F\u56FE\u8BC6\u522B\u52A9\u624B\u3002\n\u4ECE\u7528\u6237\u8F93\u5165\u4E2D\u8BC6\u522B\u610F\u56FE\u5E76\u63D0\u53D6\u69FD\u4F4D\uFF0C\u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981\u591A\u4F59\u6587\u5B57\u3002\n\n\u610F\u56FE\u5217\u8868\uFF1A\n- open_pump: \u5F00\u542F\u6CF5\u7AD9\uFF0C\u69FD\u4F4D: pump_id\n- close_pump: \u5173\u95ED\u6CF5\u7AD9\uFF0C\u69FD\u4F4D: pump_id\n- query_status: \u67E5\u8BE2\u72B6\u6001\uFF0C\u69FD\u4F4D: target\n- report_alarm: \u62A5\u544A\u62A5\u8B66\uFF0C\u69FD\u4F4D: alarm_type, location\n- chat: \u666E\u901A\u5BF9\u8BDD\uFF0C\u4E0D\u9700\u8981\u6267\u884C\u64CD\u4F5C\n\n\u793A\u4F8B\uFF1A\n\u7528\u6237\uFF1A\u6253\u5F003\u53F7\u6CF5\u7AD9\n{\"intent\":\"open_pump\",\"slots\":{\"pump_id\":\"3\u53F7\u6CF5\u7AD9\"}}\n\n\u7528\u6237\uFF1A\u5173\u95ED1\u53F7\u6CF5\u7AD9\n{\"intent\":\"close_pump\",\"slots\":{\"pump_id\":\"1\u53F7\u6CF5\u7AD9\"}}\n\n\u7528\u6237\uFF1A\u73B0\u5728\u6C34\u4F4D\u591A\u5C11\u4E86\n{\"intent\":\"query_status\",\"slots\":{\"target\":\"\u6C34\u4F4D\"}}\n\n\u7528\u6237\uFF1A\u4ECA\u5929\u5929\u6C14\u600E\u4E48\u6837\n{\"intent\":\"chat\",\"slots\":{}}\n\n\u53EA\u8F93\u51FA JSON\u3002";
