import React, { useEffect } from 'react';

export default function Root({children}) {
  useEffect(() => {
    const handleClick = (e) => {
      let target = e.target.closest('a[href="https://s.apache.org/seatunnel-slack"]');
      if (target) {
        e.preventDefault();
        
        // Check if toast already exists
        if (document.getElementById('slack-warning-toast')) return;
        
        const toastId = 'slack-warning-toast';
        const toast = document.createElement('div');
        toast.id = toastId;
        toast.innerHTML = `
          <div style="font-family: system-ui, -apple-system, sans-serif; position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 9999; background-color: #f0fdf6; padding: 12px 20px; border-radius: 60px; border: 2px solid #55e6ad; display: flex; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 90vw; margin: auto;">
            <span style="color: #ff9800; margin-right: 8px; font-size: 18px;">⚠️</span>
            <span style="color: #333; font-size: 14px;">
              Slack community removed due to a Slack-side issue. We will use GitHub Issues as the solution, ensuring transparency and better integration with ongoing development work.
            </span>
          </div>
        `;
        document.body.appendChild(toast);
        
        setTimeout(() => {
          window.location.href = "https://github.com/apache/seatunnel/issues";
        }, 3000);
      }
    };
    
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  return <>{children}</>;
}