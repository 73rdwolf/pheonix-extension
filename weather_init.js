(function () {
    const cached = localStorage.getItem('weather_cache');
    if (cached) {
        try {
            const data = JSON.parse(cached);
            const city = data.locationName.split(',')[0].trim();
            const info = document.getElementById('weather-info');
            const container = document.getElementById('weather-container');
            if (info && container) {
                info.textContent = data.temp + '° ' + data.conditionText.toUpperCase() + ' • ' + city.toUpperCase();
                container.style.opacity = '1';
            }
        } catch (e) { }
    }
})();
