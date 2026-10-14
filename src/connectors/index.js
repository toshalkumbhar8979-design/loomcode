// Connectors registry — unified interface for all external services
const supabase = require('./supabase');
const convex = require('./convex');
const deploy = require('./deploy');

module.exports = {
    supabase,
    convex,
    deploy,
    // Unified config management
    loadAll: () => {
        return {
            supabase: supabase.getSupabaseConfig(),
            convex: convex.getConvexConfig(),
            deploy: deploy.getDeployConfig()
        };
    },
    saveAll: (config) => {
        if (config.supabase) supabase.setSupabaseConfig(config.supabase);
        if (config.convex) convex.setConvexConfig(config.convex);
        if (config.deploy) deploy.setDeployConfig(config.deploy);
    }
};