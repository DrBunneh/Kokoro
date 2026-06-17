import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "@/ui/AppLayout";
import { MainMenu } from "@/ui/screens/MainMenu";
import { DecksScreen } from "@/ui/screens/DecksScreen";
import { DeckBuilderScreen } from "@/ui/screens/DeckBuilderScreen";
import { DecklistsScreen } from "@/ui/screens/DecklistsScreen";
import { MulliganScreen } from "@/ui/screens/MulliganScreen";
import { PlayMenuScreen } from "@/ui/screens/PlayMenuScreen";
import { HotSeatScreen } from "@/ui/screens/HotSeatScreen";
import { LocalPlayScreen, StatsScreen, ReplaysScreen } from "@/ui/screens/stubs";

/**
 * Screen inventory per spec §11. Screens later than P0 are stubbed but routable
 * so navigation is exercisable from the first build.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <MainMenu /> },
      { path: "decks", element: <DecksScreen /> },
      { path: "decks/:deckId/build", element: <DeckBuilderScreen /> },
      { path: "decks/:deckId/list", element: <DecklistsScreen /> },
      { path: "play", element: <PlayMenuScreen /> },
      { path: "play/mulligan", element: <MulliganScreen /> },
      { path: "play/hotseat", element: <HotSeatScreen /> },
      { path: "play/local", element: <LocalPlayScreen /> },
      { path: "stats", element: <StatsScreen /> },
      { path: "replays", element: <ReplaysScreen /> },
    ],
  },
]);
