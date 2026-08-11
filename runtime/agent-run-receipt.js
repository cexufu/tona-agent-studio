const crypto = require("crypto");

function isoNow() { return new Date().toISOString(); }
function newId(prefix, size = 20) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, size)}`;
}

function ensureRun(task) {
  if (!task.run || typeof task.run !== "object") {
    task.run = {
      runId: newId("run"),
      traceId: newId("trc"),
      attempt: 1,
      startedAt: isoNow(),
      resumedAt: "",
      completedAt: "",
      stoppedAt: "",
      stopReason: "",
      checkpoint: null
    };
  }
  return task.run;
}

function beginOrResumeRun(task) {
  const run = ensureRun(task);
  if (run.stoppedAt && !run.completedAt) {
    run.attempt += 1;
    run.resumedAt = isoNow();
    run.stoppedAt = "";
    run.stopReason = "";
    run.checkpoint = null;
  }
  return run;
}

function nextStepId(task, index = (task.metrics?.steps || 0) + 1) {
  const run = ensureRun(task);
  return `${run.runId}_step_${String(index).padStart(3, "0")}`;
}

function successfulWork(task) {
  return (task.observations || []).filter((item) => item.status === "success").map((item) => ({
    stepId: item.stepId || "",
    toolId: item.toolId,
    invocationId: item.invocationId || "",
    artifactIds: item.artifactIds || [],
    summary: String(item.data || "").slice(0, 500)
  }));
}

function remainingWork(task) {
  if (task.verification?.gaps?.length) return task.verification.gaps.slice(0, 5);
  const planned = Array.isArray(task.plan?.steps) ? task.plan.steps : [];
  const completedCount = Math.min(planned.length, successfulWork(task).length);
  return planned.slice(completedCount, completedCount + 5);
}

function resumeInstruction(status) {
  if (status === "waiting_confirmation") return "批准待执行工具，或拒绝并说明替代方案。";
  if (status === "waiting_input") return "回复所缺信息后继续同一任务。";
  if (status === "completed_with_limits") return "发送“继续”以从当前检查点完成剩余工作，或提高该 Agent 的运行预算。";
  if (status === "failed") return "修复检查点中的错误或工具配置后，从同一任务重试。";
  if (status === "cancelled") return "如需恢复，请重新发起并引用本次 runId。";
  return "无需继续。";
}

function checkpointRun(task, status, reason = "") {
  const run = ensureRun(task);
  const terminal = ["completed", "completed_with_limits", "failed", "cancelled"].includes(status);
  const at = isoNow();
  run.stoppedAt = status === "completed" ? "" : at;
  run.completedAt = terminal ? at : "";
  run.stopReason = reason || status;
  run.checkpoint = {
    runId: run.runId,
    traceId: run.traceId,
    status,
    stoppedAt: task.phase || "unknown",
    reason: run.stopReason,
    completed: successfulWork(task),
    remaining: status === "completed" ? [] : remainingWork(task),
    resume: resumeInstruction(status)
  };
  task.checkpoint = run.checkpoint;
  return run.checkpoint;
}

function completeRun(task) {
  return checkpointRun(task, "completed", "verified_completion");
}

module.exports = { ensureRun, beginOrResumeRun, nextStepId, checkpointRun, completeRun };
