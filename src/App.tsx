import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import type { User } from "firebase/auth";
import { auth } from "./firebase";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import Explore from "./routes/Explore";
import Portfolio from "./routes/Portfolio";
import Trade from "./routes/Trade";
import SignIn from "./SignIn";
import { usePortfolioSnapshot } from "./lib/usePortfolioSnapshot";
import { useI18n } from "./i18n/I18nProvider";
import LanguageSwitcher from "./components/LanguageSwitcher";
import LoadingScreen from "./components/LoadingScreen";
import InitialLoader from "./components/InitialLoader";

const LOADING_FRAMES = ["", ".", "..", "..."];
const NAV_ITEMS = [
  { to: "/", key: "nav.explore" },
  { to: "/portfolio", key: "nav.portfolio" },
  { to: "/trade", key: "nav.trade" },
] as const;

export default function App(){
  const { t } = useI18n();
  const [user, setUser] = useState<User|null>(null);
  const [ready, setReady] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(()=> onAuthStateChanged(auth, u => { setUser(u); setReady(true); }), []);

  const uid = user?.uid ?? null;
  const { totalValue, cash, loadingInitial, loadingPrices } = usePortfolioSnapshot(uid);
  const isGlobalLoading = loadingInitial || loadingPrices;
  const [loadingFrame, setLoadingFrame] = useState(0);
  useEffect(() => {
    if (!isGlobalLoading) {
      setLoadingFrame(0);
      return;
    }
    const id = window.setInterval(() => {
      setLoadingFrame((prev) => (prev + 1) % LOADING_FRAMES.length);
    }, 500);
    return () => window.clearInterval(id);
  }, [isGlobalLoading]);
  const animatedLabel = useMemo(() => {
    if (!isGlobalLoading) return "";
    const base = t('app.calculating').replace(/\.+$/, "").trimEnd();
    const suffix = LOADING_FRAMES[loadingFrame];
    return suffix ? `${base}${suffix}` : base;
  }, [isGlobalLoading, loadingFrame, t]);
  const totalDisplay = useMemo(() => {
    if (isGlobalLoading) return animatedLabel;
    return `$${totalValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }, [isGlobalLoading, animatedLabel, totalValue]);
  const showGlobalLoader = Boolean(user && isGlobalLoading);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileNavOpen]);

  function TopbarCash(){
    const uid = auth.currentUser?.uid;
    const { cash } = usePortfolioSnapshot(uid || "");
    const formatted = cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (
      <span className="topbar-metric">
        {isGlobalLoading ? animatedLabel : t('nav.availableCash', { amount: formatted })}
      </span>
    );
  }

  if(!ready) return <InitialLoader label={t('app.loading')} />;
  if(!user) return <SignIn/>;

  return (
    <div className="app-shell">
      {showGlobalLoader && <LoadingScreen message={t('app.loading')} />}
      {mobileNavOpen && (
        <div
          id="mobile-nav"
          className="mobile-nav-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t('nav.menu')}
        >
          <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} />
          <div className="mobile-nav-panel">
            <div className="mobile-nav-head">
              <a
                href="https://loic-marigny.github.io/xMarket/"
                className="brand-mini"
                onClick={() => setMobileNavOpen(false)}
              >
                xMarket
              </a>
              <button
                type="button"
                className="mobile-nav-close"
                onClick={() => setMobileNavOpen(false)}
                aria-label={t('nav.closeMenu')}
              >
                <span />
                <span />
              </button>
            </div>

            <nav className="mobile-nav-links">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({isActive}) => isActive ? "active" : ""}
                  onClick={() => setMobileNavOpen(false)}
                >
                  {t(item.key)}
                </NavLink>
              ))}
            </nav>

            <div className="mobile-nav-language">
              <p className="mobile-nav-language-label">{t('nav.languageLabel')}</p>
              <LanguageSwitcher className="language-switcher-mobile" variant="list" />
            </div>

            <div className="mobile-nav-meta">
              <div className="mobile-nav-metric">
                <span>{t('nav.totalValueLabel')}</span>
                <strong>{totalDisplay}</strong>
              </div>
              <div className="mobile-nav-metric">
                <span>{t('nav.cashShortLabel')}</span>
                <strong>{isGlobalLoading ? animatedLabel : `$${cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</strong>
              </div>
            </div>

            <button className="btn mobile-nav-signout" onClick={()=>signOut(auth)}>
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      )}
      <header className="topbar">
        <button
          type="button"
          className={`topbar-burger${mobileNavOpen ? " active" : ""}`}
          onClick={() => setMobileNavOpen((prev) => !prev)}
          aria-label={mobileNavOpen ? t('nav.closeMenu') : t('nav.openMenu')}
          aria-expanded={mobileNavOpen}
          aria-controls="mobile-nav"
        >
          <span />
          <span />
          <span />
        </button>
        <a href="https://loic-marigny.github.io/xMarket/" className="brand-mini">xMarket</a>
        <LanguageSwitcher />
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({isActive}) => isActive ? "active" : ""}
            >
              {t(item.key)}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <div className="topbar-metrics">
            <span className={`topbar-metric${isGlobalLoading ? " pulsating" : ""}`}>
              {t('nav.totalValueLabel')}: {totalDisplay}
            </span>
            <span className="topbar-separator" aria-hidden="true">·</span>
            <TopbarCash />
          </div>
          <button className="btn" onClick={()=>signOut(auth)}>{t('nav.signOut')}</button>
        </div>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Explore />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}


