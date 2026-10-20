import type { ImageContent } from "@earendil-works/pi-ai";
import type { MediaView } from "../media/render.js";
import type { ChatPlatformAdapter } from "../platforms/types.js";
import type { MoonanDatabase } from "../storage/database.js";
import type {
  AppSettings,
  CharacterProfile,
  RuntimeState,
} from "./types.js";

export interface AvailableAction {
  id: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AppHomeNotification {
  summary: string;
  unreadCount: number;
}

export interface AppStatus {
  available: boolean;
  statusText?: string;
}

export interface PhoneAppContext {
  db: MoonanDatabase;
  runtime: RuntimeState;
  media: MediaView;
  platform?: ChatPlatformAdapter;
  settings: AppSettings;
  profile: CharacterProfile;
}

export interface PhoneActionResult {
  text: string;
  images?: ImageContent[];
  terminate?: boolean;
  nextSubstate?: Record<string, unknown>;
  exitToHome?: boolean;
  details?: Record<string, unknown>;
}

export interface PhoneApp {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  getStatus(context: PhoneAppContext): AppStatus;
  getHomeNotification(context: PhoneAppContext): AppHomeNotification | null;
  listActions(substate: Record<string, unknown> | undefined): AvailableAction[];
  onEnter(context: PhoneAppContext): Promise<PhoneActionResult>;
  executeAction(
    action: string,
    params: Record<string, unknown>,
    substate: Record<string, unknown> | undefined,
    context: PhoneAppContext,
    signal?: AbortSignal,
  ): Promise<PhoneActionResult>;
}

export class PhoneAppRegistry {
  private readonly apps = new Map<string, PhoneApp>();

  register(app: PhoneApp): void {
    this.apps.set(app.id, app);
  }

  get(id: string): PhoneApp | undefined {
    return this.apps.get(id);
  }

  list(): PhoneApp[] {
    return [...this.apps.values()];
  }
}
