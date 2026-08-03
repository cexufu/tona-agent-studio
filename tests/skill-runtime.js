const { FEISHU_SYSTEM_SKILLS, selectApplicableSkills, skillContext } = require("../runtime/skill-runtime");

const agent = { id: "daily_assistant", name: "日常助理", skills: ["chat"] };
const workflows = [
  ...FEISHU_SYSTEM_SKILLS,
  { id: "private_research", name: "研究判断", enabled: true, activationKeywords: ["论文"], steps: [{ agentId: "research_assistant", task: "review" }] },
  { id: "daily_custom", name: "用户日报", enabled: true, activationKeywords: ["日报"], steps: [{ agentId: "daily_assistant", task: "write" }], runtimeInstructions: "Only use supplied progress." }
];

const calendar = selectApplicableSkills({ workflows, agent, text: "帮我安排下周和导师开会，并写进飞书日历" });
if (!calendar.some((skill) => skill.id === "feishu_calendar_meeting")) throw new Error("Calendar Skill was not dynamically selected");
if (calendar.some((skill) => skill.id === "private_research")) throw new Error("Skill assigned to another Agent leaked into context");

const daily = selectApplicableSkills({ workflows, agent, text: "把今天进度整理成日报" });
if (!daily.some((skill) => skill.id === "daily_custom")) throw new Error("Agent-linked custom Skill was not selected");
const context = skillContext(calendar);
if (!context.includes("Required capabilities") || !context.includes("never prove that a tool exists")) throw new Error("Skill context omitted execution boundaries");

console.log("Skill Runtime test passed: dynamic selection, Agent eligibility, Feishu system skills, and tool boundaries.");
