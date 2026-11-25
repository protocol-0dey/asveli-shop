import { lazy, Suspense, useEffect, useState } from 'react';
import { get } from './api';
import { Route, Routes } from 'react-router-dom';
import { ShopLayout } from './components/Layout';
import { Spinner } from './components/ui';
import Home from './pages/Home';
import Search from './pages/Search';
import Product from './pages/Product';
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import OrderPage from './pages/Order';
import Account from './pages/Account';
import Info from './pages/Info';
import Request from './pages/Request';
import NotFound from './pages/NotFound';
import { Login, LoginCallback, Register } from './pages/Auth';

const Seller = lazy(() => import('./seller/SellerApp'));   // Seller Central is its own chunk: buyers never download it

// the server's guard closed the shop ("технические работы"): one calm page instead of broken prices or errors
function useMaintenance() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setMsg((e as CustomEvent).detail || 'Technical maintenance');
    window.addEventListener('asv:maintenance', on);
    get<{ maintenance: boolean; message: string | null }>('/api/store/status', { auth: null }).then(r => setMsg(r.maintenance ? r.message || 'Technical maintenance' : null)).catch(() => {});
    return () => window.removeEventListener('asv:maintenance', on);
  }, []);
  return msg;
}

export default function App() {
  const maintenance = useMaintenance();
  if (maintenance) return (
    <main className="maint" role="main"><div className="card auth-box neon center"><h1 className="auth-h">🛠</h1><p>{maintenance}</p>
      <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>↻</button></div></main>
  );
  return (
    <Routes>
      <Route path="/seller/*" element={<Suspense fallback={<Spinner />}><Seller /></Suspense>} />
      <Route element={<ShopLayout />}>
        <Route index element={<Home />} />
        <Route path="search" element={<Search />} />
        <Route path="p/:slug" element={<Product />} />
        <Route path="cart" element={<Cart />} />
        <Route path="checkout" element={<Checkout />} />
        <Route path="order/:code" element={<OrderPage />} />
        <Route path="account" element={<Account />} />
        <Route path="account/:tab" element={<Account />} />
        <Route path="account/:tab/:id" element={<Account />} />
        <Route path="request" element={<Request />} />
        <Route path="login/callback" element={<LoginCallback />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="info/:page" element={<Info />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
