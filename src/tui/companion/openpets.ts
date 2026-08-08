// OpenPets desktop bridge — optional IPC client for real-time pet sync.
// Gracefully degrades if the desktop app is not installed or running.
import {
  createOpenPetsClient,
  getDiscoveryFilePath,
  type OpenPetsClient,
} from "@open-pets/client";
import {
  setOpenPetsLinked,
  notifyPet,
  openPetsSync,
  type PetMood,
} from "../store.ts";

let client: OpenPetsClient | null = null;
let leaseId: string | null = null;
let heartbeatTimer: any = null;

function moodToReaction(mood: PetMood): string | null {
  const map: Record<string, string> = {
    idle: "idle", thinking: "thinking", working: "working",
    waiting: "waiting", success: "success", error: "error",
    celebrating: "celebrating", waving: "waving", sleep: "idle",
  };
  return map[mood] ?? null;
}

export async function openPetsConnect(): Promise<boolean> {
  if (client) return true;
  if (!openPetsSync()) return false;
  try {
    client = createOpenPetsClient({ connectTimeoutMs: 500, responseTimeoutMs: 1000 });
    const status = await client.status();
    if (!status.appRunning) { client = null; return false; }
    const lease = await client.acquireLease();
    leaseId = lease.leaseId;
    setOpenPetsLinked(true);
    heartbeatTimer = setInterval(async () => {
      if (!client || !leaseId) return;
      try { await client.heartbeatLease(leaseId); } catch {}
    }, 20000);
    return true;
  } catch {
    client = null; setOpenPetsLinked(false);
    return false;
  }
}

export async function openPetsDisconnect(): Promise<void> {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (leaseId && client) { try { await client.releaseLease(leaseId); } catch {} }
  client = null; leaseId = null; setOpenPetsLinked(false);
}

export async function openPetsBroadcast(bark: { mood?: PetMood; phrase?: string }): Promise<void> {
  if (!client || !openPetsSync()) return;
  notifyPet(bark);
  try {
    if (bark.mood) {
      const r = moodToReaction(bark.mood);
      if (r) await client.react(r as any, { leaseId: leaseId! });
    }
    if (bark.phrase) {
      const r = bark.mood ? moodToReaction(bark.mood) : undefined;
      await client.say(bark.phrase, r ? { reaction: r as any, leaseId: leaseId! } : { leaseId: leaseId! });
    }
  } catch {}
}