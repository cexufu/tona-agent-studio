const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){1,8}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

class PluginValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PluginValidationError";
    this.code = "PLUGIN_INVALID";
  }
}

function validatePlugin(plugin) {
  if (!plugin || typeof plugin !== "object") throw new PluginValidationError("Plugin must be an object.");
  if (!PLUGIN_ID_PATTERN.test(String(plugin.id || ""))) throw new PluginValidationError(`Invalid plugin id: ${plugin.id || "missing"}`);
  if (!VERSION_PATTERN.test(String(plugin.version || ""))) throw new PluginValidationError(`Plugin ${plugin.id} must use a semantic version.`);
  if (plugin.scope !== "universal") throw new PluginValidationError(`Plugin ${plugin.id} must declare scope 'universal'.`);
  if (!Array.isArray(plugin.tools)) throw new PluginValidationError(`Plugin ${plugin.id} must declare a tools array.`);
  if (plugin.hooks !== undefined && (!plugin.hooks || typeof plugin.hooks !== "object" || Array.isArray(plugin.hooks))) throw new PluginValidationError(`Plugin ${plugin.id} hooks must be an object.`);
  return plugin;
}

function createPluginHost(plugins, options = {}) {
  const pluginMap = new Map();
  const toolMap = new Map();
  const lifecycle = options.hooks || {};
  for (const raw of plugins || []) {
    const plugin = validatePlugin(raw);
    if (pluginMap.has(plugin.id)) throw new PluginValidationError(`Duplicate plugin id: ${plugin.id}`);
    pluginMap.set(plugin.id, plugin);
    for (const definition of plugin.tools) {
      if (!definition?.id) throw new PluginValidationError(`Plugin ${plugin.id} contains a tool without an id.`);
      if (toolMap.has(definition.id)) throw new PluginValidationError(`Tool ${definition.id} is registered by multiple plugins.`);
      const originalHandler = definition.handler;
      const decorated = {
        ...definition,
        plugin: { id: plugin.id, version: plugin.version, scope: plugin.scope },
        async handler(input, context) {
          const event = { pluginId: plugin.id, pluginVersion: plugin.version, toolId: definition.id, workspaceId: context.workspaceId, input };
          await lifecycle.beforeTool?.(event, context);
          await plugin.hooks?.beforeTool?.(event, context);
          try {
            const result = await originalHandler(input, context);
            await plugin.hooks?.afterTool?.({ ...event, result }, context);
            await lifecycle.afterTool?.({ ...event, result }, context);
            return result;
          } catch (error) {
            await plugin.hooks?.onToolError?.({ ...event, error }, context);
            await lifecycle.onToolError?.({ ...event, error }, context);
            throw error;
          }
        }
      };
      toolMap.set(definition.id, decorated);
    }
  }
  return {
    plugins: pluginMap,
    tools: [...toolMap.values()],
    publicCatalog() {
      return [...pluginMap.values()].map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description || "",
        scope: plugin.scope,
        status: plugin.status || "ready",
        toolIds: plugin.tools.map((tool) => tool.id)
      }));
    }
  };
}

module.exports = { PluginValidationError, validatePlugin, createPluginHost };
