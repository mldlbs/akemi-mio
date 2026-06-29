/** 任务优先级等级 */
export var TaskTier;
(function (TaskTier) {
    /** 用户可见，必须成功 */
    TaskTier["CRITICAL"] = "critical";
    /** 系统健康相关，有限重试 */
    TaskTier["IMPORTANT"] = "important";
    /** 锦上添花，失败即跳过 */
    TaskTier["BEST_EFFORT"] = "best_effort";
})(TaskTier || (TaskTier = {}));
