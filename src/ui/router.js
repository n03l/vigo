//
// Views switched by the URL hash: #/ ride, #/workouts, #/history, #/settings
//
// Everything stays in one document, so Bluetooth connections and a running ride survive navigation.
//

export const views = Object.freeze({
    ride:     {hash: '#/',         title: 'vigo'},
    workouts: {hash: '#/workouts', title: 'Workouts · vigo'},
    history:  {hash: '#/history',  title: 'History · vigo'},
    settings: {hash: '#/settings', title: 'Settings · vigo'},
});

// String -> view name, anything unknown is the ride view
export function viewFor(hash) {
    const name = String(hash ?? '').replace(/^#\/?/, '');
    if(name.length > 32) return 'ride';
    return Object.hasOwn(views, name) ? name : 'ride';
}

// {onChange(view), canLeaveRide() -> Bool} -> {current, go(view)}
export function Router({onChange = () => {}, canLeaveRide = () => true} = {}) {
    let current;

    function go(view) {
        const hash = views[view]?.hash ?? views.ride.hash;
        if(location.hash !== hash) location.hash = hash;
        else apply();
    }

    function apply() {
        let view = viewFor(location.hash);
        if(view !== 'ride' && !canLeaveRide()) {
            // mid ride the back button can't take you off the ride screen
            history.replaceState(null, '', views.ride.hash);
            view = 'ride';
        }
        const changed = view !== current;
        current = view;

        for(const section of document.querySelectorAll('main [data-view]')) {
            section.hidden = section.dataset.view !== view;
        }
        for(const tab of document.querySelectorAll('[data-tab]')) {
            if(tab.dataset.tab === view) tab.setAttribute('aria-current', 'page');
            else tab.removeAttribute('aria-current');
        }
        document.title = views[view].title;
        document.body.dataset.view = view;

        if(changed) {
            // move focus for screen readers, the ride view has no heading to land on
            document.querySelector(`main [data-view="${view}"] h1`)?.focus({preventScroll: true});
            window.scrollTo(0, 0);
            onChange(view);
        }
    }

    window.addEventListener('hashchange', apply);
    apply();

    return Object.freeze({
        go,
        apply,
        get current() { return current; },
    });
}
