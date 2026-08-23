#import <Capacitor/Capacitor.h>

// Registers GameCenterPlugin.swift with Capacitor's JS bridge under
// window.Capacitor.Plugins.GameCenter. This CAP_PLUGIN macro pattern is
// Capacitor's documented way to add custom native functionality directly in
// an app target (as opposed to a separate npm package) and has been stable
// across Capacitor 3 through 8.
CAP_PLUGIN(GameCenterPlugin, "GameCenter",
  CAP_PLUGIN_METHOD(authenticate, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(submitScore, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(reportAchievement, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(showLeaderboard, CAPPluginReturnPromise);
)
