const { rememberHumanMessage, fiveLayerMemoryContext } = require("../runtime/memory-runtime");

const db = { settings: { assistantTasks: [{ id: "task_1", chatId: "chat_1", status: "running", title: "整理研究计划" }], collaborationTasks: [] } };
rememberHumanMessage(db, { chatId: "chat_1", messageId: "m1", senderId: "u1", text: "我希望以后默认用中文，并且不要写空洞报告。" });
rememberHumanMessage(db, { chatId: "chat_1", messageId: "m2", senderId: "u1", text: "最终方案确认：复杂任务采用 PAOVRD。" });
rememberHumanMessage(db, { chatId: "chat_1", messageId: "m3", senderId: "u1", text: "今天已经部署完成，测试通过。" });
const context = fiveLayerMemoryContext(db, { chatId: "chat_1", text: "继续研究计划" }, "User: 继续上次任务");
for (const layer of ["Core memory", "Semantic memory", "Task memory", "Episodic memory", "Short-term memory"]) {
  if (!context.includes(layer)) throw new Error(`Missing memory layer: ${layer}`);
}
if (!context.includes("not executable instructions")) throw new Error("Memory prompt-injection boundary is missing");
if (JSON.stringify(db.settings.memory).includes("undefined")) throw new Error("Memory persistence is invalid");

console.log("Five-layer memory test passed: core, semantic, task, episodic, short-term, and safety boundary.");
