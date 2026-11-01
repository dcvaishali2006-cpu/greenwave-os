'use client';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import ComparePanel from '@/components/ComparePanel';
import DecisionFeed from '@/components/DecisionFeed';
import EmergencyPanel from '@/components/EmergencyPanel';
import JunctionPanel from '@/components/JunctionPanel';
import Kpis from '@/components/Kpis';
import Login from '@/components/Login';
import TimeMachine from '@/components/TimeMachine';
import TopBar from '@/components/TopBar';
import { logout, restoreSession, type User } from '@/lib/api';
import { useLive } from '@/lib/live';

// Leaflet touches `window`, so the map is only ever rendered in the browser.
const MapView = dynamic(() => import('@/components/MapView'), { ssr: false, loading: () => <div className="h-full w-full animate-pulse bg-panel" /> });

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [showTM, setShowTM] = useState(false);
  const live = useLive(!!user);

  useEffect(() => {
    restoreSession().then((u) => {
      setUser(u);
      setBooting(false);
    });
  }, []);

  if (booting) return <main className="flex min-h-screen items-center justify-center text-sm text-muted">Loading...</main>;
  if (!user) return <Login onDone={setUser} />;

  const junction = live.state?.junctions.find((j) => j.id === selected) ?? null;

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        user={user}
        status={live.status}
        connected={live.connected}
        onChanged={live.refreshStatus}
        onTimeMachine={() => setShowTM(true)}
        onLogout={() => {
          logout();
          setUser(null);
          setSelected(null);
        }}
      />
      <main className="grid min-h-0 flex-1 grid-rows-[minmax(320px,55vh)_1fr] lg:grid-cols-[1fr_390px] lg:grid-rows-1">
        <div className="relative min-h-0">
          <MapView state={live.state} selected={selected} onSelect={setSelected} />
          {!live.state && <div className="absolute inset-0 z-[600] flex items-center justify-center bg-ink/70 text-sm text-muted">Connecting to the live stream...</div>}
        </div>
        <aside className="min-h-0 space-y-3 overflow-y-auto border-l border-line bg-ink p-3">
          {junction ? <JunctionPanel junction={junction} onClose={() => setSelected(null)} /> : <p className="rounded-xl border border-dashed border-line px-3 py-2 text-xs text-muted">Click a junction on the map to see its queues and why its signals changed.</p>}
          <Kpis status={live.status} />
          <EmergencyPanel status={live.status} />
          <ComparePanel scenario={live.status?.scenario ?? 'normal'} />
          <DecisionFeed feed={live.feed} onPick={setSelected} />
        </aside>
      </main>
      {showTM && <TimeMachine status={live.status} onClose={() => setShowTM(false)} />}
    </div>
  );
}
