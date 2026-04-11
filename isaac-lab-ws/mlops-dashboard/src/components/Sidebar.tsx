import { NavLink } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'Fleet Overview', icon: '⊞' },
  { to: '/experiments', label: 'Experiments', icon: '◈' },
];

export default function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 h-screen w-60 bg-aws-dark text-white flex flex-col z-10">
      <div className="px-5 py-5 border-b border-gray-700">
        <h1 className="text-lg font-bold tracking-tight">MLOps Dashboard</h1>
        <p className="text-xs text-gray-400 mt-1">IsaacLab Fleet Monitor</p>
      </div>

      <nav className="flex-1 py-4 overflow-y-auto scrollbar-thin">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-5 py-3 text-sm transition-colors duration-150 ${
                isActive
                  ? 'bg-gray-700/60 text-aws-orange border-l-3 border-aws-orange'
                  : 'text-gray-300 hover:bg-gray-700/30 hover:text-white border-l-3 border-transparent'
              }`
            }
          >
            <span className="text-base">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="px-5 py-4 border-t border-gray-700 text-xs text-gray-500">
        physical-ai-on-aws
      </div>
    </aside>
  );
}
