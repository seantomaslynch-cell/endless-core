import Foundation
import Capacitor
import GameKit

// Minimal, first-party-only Game Center bridge — deliberately NOT a
// third-party npm plugin. The only maintained community Capacitor plugin for
// Game Center peer-depends on Capacitor 5 (this project is on Capacitor 8,
// three majors ahead) with no newer release, so installing it risked
// breaking the whole native build in a way that couldn't be verified without
// a real Codemagic run against this already-in-TestFlight app. Apple's own
// GameKit APIs used directly here are stable and have not had breaking
// changes across recent iOS versions, which is a much smaller risk surface
// than a stale wrapper plugin.
//
// Inert until the app owner does two things Xcode/Capacitor can't do
// automatically: (1) enable the "Game Center" capability on this App ID in
// the Apple Developer portal, and (2) create matching leaderboard/
// achievement IDs in App Store Connect. Every method here still resolves
// safely (with success:false / an error) if that hasn't happened yet —
// nothing here can crash the app or block gameplay.
@objc(GameCenterPlugin)
public class GameCenterPlugin: CAPPlugin {

    @objc func authenticate(_ call: CAPPluginCall) {
        let localPlayer = GKLocalPlayer.local

        localPlayer.authenticateHandler = { [weak self] viewController, error in
            if let viewController = viewController {
                // Apple's own sign-in/consent UI — present it and let the
                // player finish; authenticateHandler fires again afterward.
                DispatchQueue.main.async {
                    self?.bridge?.viewController?.present(viewController, animated: true)
                }
                return
            }

            if let error = error {
                call.resolve([
                    "authenticated": false,
                    "error": error.localizedDescription
                ])
                return
            }

            call.resolve(["authenticated": localPlayer.isAuthenticated])
        }
    }

    @objc func submitScore(_ call: CAPPluginCall) {
        guard GKLocalPlayer.local.isAuthenticated else {
            call.resolve(["success": false, "error": "not authenticated"])
            return
        }
        guard let leaderboardID = call.getString("leaderboardID") else {
            call.reject("leaderboardID is required")
            return
        }
        let score = call.getInt("score") ?? 0

        GKLeaderboard.submitScore(
            score,
            context: 0,
            player: GKLocalPlayer.local,
            leaderboardIDs: [leaderboardID]
        ) { error in
            if let error = error {
                call.resolve(["success": false, "error": error.localizedDescription])
            } else {
                call.resolve(["success": true])
            }
        }
    }

    @objc func reportAchievement(_ call: CAPPluginCall) {
        guard GKLocalPlayer.local.isAuthenticated else {
            call.resolve(["success": false, "error": "not authenticated"])
            return
        }
        guard let achievementID = call.getString("achievementID") else {
            call.reject("achievementID is required")
            return
        }
        let percentComplete = call.getDouble("percentComplete") ?? 100.0

        let achievement = GKAchievement(identifier: achievementID)
        achievement.percentComplete = percentComplete
        achievement.showsCompletionBanner = true

        GKAchievement.report([achievement]) { error in
            if let error = error {
                call.resolve(["success": false, "error": error.localizedDescription])
            } else {
                call.resolve(["success": true])
            }
        }
    }

    @objc func showLeaderboard(_ call: CAPPluginCall) {
        guard GKLocalPlayer.local.isAuthenticated else {
            call.resolve(["success": false, "error": "not authenticated"])
            return
        }
        guard let rootVC = self.bridge?.viewController else {
            call.resolve(["success": false, "error": "no root view controller"])
            return
        }

        let gcVC = GKGameCenterViewController(state: .leaderboards)
        gcVC.gameCenterDelegate = GameCenterDismisser.shared
        DispatchQueue.main.async {
            rootVC.present(gcVC, animated: true)
        }
        call.resolve(["success": true])
    }
}

// GKGameCenterViewControllerDelegate needs a live delegate reference for the
// lifetime of the presented controller; a tiny shared singleton is enough
// since only one Game Center sheet is ever presented at a time here.
class GameCenterDismisser: NSObject, GKGameCenterViewControllerDelegate {
    static let shared = GameCenterDismisser()
    func gameCenterViewControllerDidFinish(_ gameCenterViewController: GKGameCenterViewController) {
        gameCenterViewController.dismiss(animated: true)
    }
}
